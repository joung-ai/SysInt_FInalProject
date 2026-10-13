const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseCsv, toCsv } = require('../lib/csv');
const { clinicDateString, parseLocalDateTime, allocateQueueSlot } = require('../lib/clinic');

const REQUIRED_COLUMNS = ['full_name', 'scheduled_at', 'reason'];
const MAX_IMPORT_ROWS = 500;

const PHILHEALTH_MAPPING = [
  ['consultation_id', row => row.consultation_id],
  ['patient_mrn', row => row.mrn],
  ['patient_name', row => row.full_name],
  ['date_of_birth', row => row.date_of_birth],
  ['phone', row => row.phone],
  ['appointment_datetime', row => row.scheduled_at],
  ['symptoms', row => row.symptoms],
  ['clinical_notes', row => row.clinical_notes],
  ['doctor_comment', row => row.doctor_comment],
  ['approved_at', row => row.reviewed_at]
];

// Transform step for one CSV row: trim, normalise formats, and validate. Returns { value } or { error }.
function transformRow(raw) {
  const clean = key => (raw[key] || '').trim();
  const fullName = clean('full_name').replace(/\s+/g, ' ');
  const mrn = clean('patient_mrn').toUpperCase();
  let phone = clean('phone').replace(/[\s\-().]/g, '');
  if (/^09\d{9}$/.test(phone)) phone = `+63${phone.slice(1)}`;
  const email = clean('email').toLowerCase();
  const reason = clean('reason').replace(/\s+/g, ' ');

  let scheduled = clean('scheduled_at').replace(' ', 'T');
  const usDate = scheduled.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})T(\d{1,2}):(\d{2})$/);
  if (usDate) {
    const [, month, day, year, hour, minute] = usDate;
    scheduled = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}`;
  }
  scheduled = scheduled.replace(/^(\d{4}-\d{2}-\d{2}T)(\d):/, (_match, day, hour) => `${day}0${hour}:`);

  const errors = [];
  if (fullName.length < 2 || fullName.length > 100) errors.push('full_name is missing or not 2-100 characters');
  if (mrn && !/^[A-Z0-9-]{3,40}$/.test(mrn)) errors.push('patient_mrn has invalid characters');
  if (phone && !/^\+?\d{10,15}$/.test(phone)) errors.push('phone is not a valid number');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('email is not valid');
  if (!parseLocalDateTime(scheduled)) errors.push('scheduled_at must be YYYY-MM-DD HH:MM or MM/DD/YYYY HH:MM');
  if (!reason || reason.length > 240) errors.push('reason is missing or longer than 240 characters');
  if (errors.length) return { error: errors.join('; ') };
  return {
    value: {
      mrn: mrn || null,
      fullName,
      phone: phone || null,
      email: email || null,
      scheduledAt: scheduled,
      reason,
      doctorUsername: clean('doctor_username') || null
    }
  };
}

module.exports = function createIntegrationsRouter({
  db,
  requireAuth,
  allow,
  audit,
  logNotification,
  logIntegration,
  exportDir
}) {
  const router = express.Router();

  router.get('/integrations/logs', requireAuth, allow('Admin'), (req, res) => {
    let sql = 'SELECT * FROM integration_logs WHERE 1 = 1';
    const params = [];
    for (const field of ['status', 'integration', 'transaction_id']) {
      if (req.query[field]) {
        sql += ` AND ${field} = ?`;
        params.push(String(req.query[field]));
      }
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 1000);
    sql += ' ORDER BY id DESC LIMIT ?';
    res.json(db.prepare(sql).all(...params, limit));
  });

  // ETL import: Extract rows from an uploaded CSV, Transform/validate them, Load valid appointments.
  router.post('/integrations/appointments/import', requireAuth, allow('Admin', 'Clinic Staff'), (req, res) => {
    const transactionId = crypto.randomUUID();
    const filename = String(req.body?.filename || 'upload.csv').slice(0, 120);
    const fail = (status, message) => {
      logIntegration({
        transactionId,
        integration: 'csv_import',
        action: 'appointments_import',
        status: 'failed',
        recordRef: filename,
        payload: { filename },
        errorMessage: message
      });
      return res.status(status).json({ error: message, transaction_id: transactionId });
    };

    if (typeof req.body?.csv !== 'string' || !req.body.csv.trim()) return fail(400, 'Provide the CSV file contents.');
    let table;
    try {
      table = parseCsv(req.body.csv);
    } catch (error) {
      return fail(400, error.message);
    }
    const header = (table.shift() || []).map(name => name.trim().toLowerCase());
    const missing = REQUIRED_COLUMNS.filter(column => !header.includes(column));
    if (missing.length) return fail(400, `CSV header is missing required column(s): ${missing.join(', ')}.`);
    if (!table.length) return fail(400, 'CSV has a header but no data rows.');
    if (table.length > MAX_IMPORT_ROWS)
      return fail(413, `CSV has ${table.length} rows; the limit is ${MAX_IMPORT_ROWS}.`);

    const findDoctor = db.prepare(
      "SELECT id FROM users WHERE username = ? COLLATE NOCASE AND role = 'Doctor' AND active = 1"
    );
    const findByMrn = db.prepare('SELECT id FROM patients WHERE mrn = ?');
    const findByNamePhone = db.prepare('SELECT id FROM patients WHERE full_name = ? AND phone = ?');
    const findDuplicate = db.prepare(
      "SELECT id FROM appointments WHERE patient_id = ? AND scheduled_at = ? AND status <> 'cancelled'"
    );
    const insertPatient = db.prepare('INSERT INTO patients(mrn, full_name, phone, email) VALUES(?, ?, ?, ?)');
    const insertAppointment = db.prepare(
      `INSERT INTO appointments(patient_id, doctor_id, scheduled_at, queue_number, queue_order, reason, created_by)
       VALUES(?, ?, ?, ?, ?, ?, ?)`
    );

    const results = [];
    const seenInFile = new Set();
    const load = db.transaction(() => {
      table.forEach((cells, index) => {
        const rowNumber = index + 2; // +1 for the header, +1 for 1-based numbering
        const raw = Object.fromEntries(header.map((column, i) => [column, cells[i] ?? '']));
        const { value, error } = transformRow(raw);
        if (error) return results.push({ row: rowNumber, status: 'failed', message: error });

        let doctorId = null;
        if (value.doctorUsername) {
          doctorId = findDoctor.get(value.doctorUsername)?.id;
          if (!doctorId)
            return results.push({
              row: rowNumber,
              status: 'failed',
              message: `Unknown doctor "${value.doctorUsername}"`
            });
        }
        const fileKey = `${value.mrn || `${value.fullName}|${value.phone}`}|${value.scheduledAt}`;
        if (seenInFile.has(fileKey)) {
          return results.push({
            row: rowNumber,
            status: 'skipped',
            message: 'Duplicate of an earlier row in this file'
          });
        }
        seenInFile.add(fileKey);

        let patientId = value.mrn
          ? findByMrn.get(value.mrn)?.id
          : value.phone
            ? findByNamePhone.get(value.fullName, value.phone)?.id
            : null;
        if (patientId && findDuplicate.get(patientId, value.scheduledAt)) {
          return results.push({
            row: rowNumber,
            status: 'skipped',
            message: 'Appointment already exists for this patient and time'
          });
        }
        if (!patientId) {
          const mrn =
            value.mrn ||
            `IMP-${clinicDateString().replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
          patientId = Number(insertPatient.run(mrn, value.fullName, value.phone, value.email).lastInsertRowid);
        }
        const { queueNumber, queueOrder } = allocateQueueSlot(db, value.scheduledAt.slice(0, 10));
        const appointment = insertAppointment.run(
          patientId,
          doctorId,
          value.scheduledAt,
          queueNumber,
          queueOrder,
          value.reason,
          req.user.id
        );
        results.push({
          row: rowNumber,
          status: 'imported',
          appointment_id: Number(appointment.lastInsertRowid),
          queue_number: queueNumber
        });
      });
    });
    load();

    const summary = {
      total: results.length,
      imported: results.filter(row => row.status === 'imported').length,
      skipped: results.filter(row => row.status === 'skipped').length,
      failed: results.filter(row => row.status === 'failed').length
    };
    const status =
      summary.imported === 0 && summary.failed > 0
        ? 'failed'
        : summary.failed || summary.skipped
          ? 'partial'
          : 'success';
    for (const row of results.filter(item => item.status === 'failed')) {
      logIntegration({
        transactionId,
        integration: 'csv_import',
        action: 'row_rejected',
        status: 'failed',
        recordRef: `${filename}#row${row.row}`,
        payload: { row: row.row },
        errorMessage: row.message
      });
    }
    logIntegration({
      transactionId,
      integration: 'csv_import',
      action: 'appointments_import',
      status,
      recordRef: filename,
      payload: { filename, ...summary },
      errorMessage: summary.failed ? `${summary.failed} row(s) rejected` : null
    });
    audit(req, 'csv_import_completed', 'integration', transactionId, { filename, ...summary });
    logNotification({
      eventType: 'csv_import',
      message: `CSV import ${filename}: ${summary.imported} imported, ${summary.skipped} skipped, ${summary.failed} rejected.`,
      status: 'system',
      recipientRole: 'Clinic Staff',
      transactionId
    });
    res.status(summary.imported ? 201 : 200).json({ transaction_id: transactionId, status, ...summary, rows: results });
  });

  // ETL export: approved consultations mapped to the PhilHealth demonstration CSV layout.
  router.post('/integrations/philhealth/export', requireAuth, allow('Admin'), (req, res) => {
    const transactionId = crypto.randomUUID();
    const rows = db
      .prepare(
        `SELECT c.id AS consultation_id, p.mrn, p.full_name, p.date_of_birth, p.phone,
                a.scheduled_at, c.symptoms, c.clinical_notes, c.doctor_comment, c.reviewed_at
         FROM consultations c
         JOIN patients p ON p.id = c.patient_id
         JOIN appointments a ON a.id = c.appointment_id
         WHERE c.status = 'approved'
         ORDER BY c.reviewed_at, c.id`
      )
      .all();
    const csv = toCsv([
      PHILHEALTH_MAPPING.map(([header]) => header),
      ...rows.map(row => PHILHEALTH_MAPPING.map(([, pick]) => pick(row)))
    ]);
    const filename = `philhealth-approved-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    const target = path.join(exportDir, filename);
    try {
      fs.writeFileSync(`${target}.tmp`, csv, 'utf8');
      fs.renameSync(`${target}.tmp`, target);
      fs.writeFileSync(path.join(exportDir, 'latest.csv'), csv, 'utf8');
    } catch (error) {
      logIntegration({
        transactionId,
        integration: 'philhealth_export',
        action: 'approved_consultations_export',
        status: 'failed',
        recordRef: filename,
        errorMessage: error.message
      });
      throw error;
    }
    logIntegration({
      transactionId,
      integration: 'philhealth_export',
      action: 'approved_consultations_export',
      status: 'success',
      recordRef: filename,
      payload: { records: rows.length }
    });
    audit(req, 'philhealth_export_created', 'export', filename, {
      records: rows.length,
      transaction_id: transactionId
    });
    logNotification({
      eventType: 'philhealth_export',
      message: `PhilHealth CSV export created with ${rows.length} approved records.`,
      status: 'system',
      responseBody: filename,
      transactionId
    });
    res.status(201).json({
      transaction_id: transactionId,
      filename,
      latest: 'latest.csv',
      records: rows.length,
      path: `server/exports/philhealth/${filename}`
    });
  });

  router.get('/integrations/philhealth/latest', requireAuth, allow('Admin'), (_req, res) => {
    const file = path.join(exportDir, 'latest.csv');
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'No PhilHealth export has been generated yet.' });
    res.download(file, 'philhealth-approved-latest.csv');
  });

  return router;
};
