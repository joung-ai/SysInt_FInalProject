const express = require('express');
const { parseLocalDateTime, allocateQueueSlot } = require('../lib/clinic');
const { doctorCanAccess, patientCanAccess } = require('../lib/access');

const TRANSITIONS = {
  booked: ['checked_in', 'cancelled'],
  checked_in: ['in_consultation', 'cancelled'],
  in_consultation: ['completed'],
  completed: [],
  cancelled: []
};

const QUEUE_EVENT_FOR_STATUS = {
  checked_in: 'manual_queue_check_in',
  in_consultation: 'manual_queue_called',
  completed: 'manual_queue_completed',
  cancelled: 'manual_queue_cancelled'
};

module.exports = function createAppointmentsRouter({ db, requireAuth, allow, audit, events }) {
  const router = express.Router();

  router.get('/appointments', requireAuth, (req, res) => {
    let sql = `SELECT a.*, p.full_name AS patient_name, p.mrn, p.date_of_birth, p.phone, u.display_name AS doctor_name,
                      c.id AS consultation_id, c.status AS consultation_status
               FROM appointments a
               JOIN patients p ON p.id = a.patient_id
               LEFT JOIN users u ON u.id = a.doctor_id
               LEFT JOIN consultations c ON c.appointment_id = a.id
               WHERE 1 = 1`;
    const params = [];
    if (req.query.date) {
      sql += ' AND date(a.scheduled_at) = date(?)';
      params.push(req.query.date);
    }
    if (req.query.doctor_id) {
      sql += ' AND a.doctor_id = ?';
      params.push(Number(req.query.doctor_id));
    }
    if (req.user.role === 'Patient') {
      sql += ' AND a.patient_id = ?';
      params.push(req.user.patient_id);
    }
    sql += ' ORDER BY a.scheduled_at, COALESCE(a.queue_order, a.queue_number), a.id';
    res.json(db.prepare(sql).all(...params));
  });

  // Visit details: one appointment with everything the integration attached to it.
  router.get('/appointments/:id', requireAuth, (req, res) => {
    const appointment = db
      .prepare(
        `SELECT a.*, p.full_name AS patient_name, p.mrn, p.date_of_birth, p.phone, p.email,
                u.display_name AS doctor_name, cb.display_name AS created_by_name
         FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         LEFT JOIN users u ON u.id = a.doctor_id
         LEFT JOIN users cb ON cb.id = a.created_by
         WHERE a.id = ?`
      )
      .get(Number(req.params.id));
    if (!appointment) return res.status(404).json({ error: 'Appointment not found.' });
    if (!patientCanAccess(req.user, appointment.patient_id) || !doctorCanAccess(req.user, appointment.doctor_id)) {
      return res.status(403).json({ error: 'You cannot access this appointment.' });
    }

    const consultation = db
      .prepare(
        `SELECT c.*, s.display_name AS submitter_name, r.display_name AS reviewer_name
         FROM consultations c
         JOIN users s ON s.id = c.submitted_by
         LEFT JOIN users r ON r.id = c.reviewed_by
         WHERE c.appointment_id = ?`
      )
      .get(appointment.id);
    const comments = consultation
      ? db
          .prepare(
            `SELECT cm.*, u.display_name AS author_name, u.role AS author_role
             FROM comments cm JOIN users u ON u.id = cm.author_id
             WHERE cm.entity_type = 'consultation' AND cm.entity_id = ? ORDER BY cm.id`
          )
          .all(consultation.id)
      : [];
    const files = db
      .prepare(
        `SELECT a.id AS asset_id, a.category, a.current_version, v.version_number, v.original_name, v.status,
                v.created_at AS version_created_at, u.display_name AS uploader_name
         FROM assets a
         JOIN asset_versions v ON v.asset_id = a.id
         JOIN users u ON u.id = v.uploaded_by
         WHERE a.patient_id = ? ORDER BY a.id DESC, v.version_number DESC`
      )
      .all(appointment.patient_id);
    const queueEvents = db
      .prepare(
        `SELECT e.event_type, e.details_json, e.created_at, u.display_name AS actor_name
         FROM queue_events e LEFT JOIN users u ON u.id = e.actor_id
         WHERE e.appointment_id = ? ORDER BY e.id`
      )
      .all(appointment.id);
    const auditTrail =
      req.user.role === 'Admin'
        ? db
            .prepare(
              `SELECT l.action, l.actor_role, l.details_json, l.created_at, u.display_name AS actor_name
               FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_id
               WHERE (l.entity_type = 'appointment' AND l.entity_id = ?)
                  OR (l.entity_type = 'consultation' AND l.entity_id = ?)
               ORDER BY l.id`
            )
            .all(String(appointment.id), consultation ? String(consultation.id) : '')
        : null;

    res.json({
      appointment,
      consultation: consultation || null,
      comments,
      files,
      queue_events: queueEvents,
      audit: auditTrail
    });
  });

  router.post('/appointments', requireAuth, allow('Admin', 'Clinic Staff', 'Patient'), (req, res) => {
    const { reason, doctor_id: doctorId = null } = req.body || {};
    const scheduledAt = parseLocalDateTime(req.body?.scheduled_at);
    const reasonText = typeof reason === 'string' ? reason.trim() : '';
    const patientId = Number(req.user.role === 'Patient' ? req.user.patient_id : req.body?.patient_id);
    const patient = Number.isFinite(patientId)
      ? db.prepare('SELECT id, full_name FROM patients WHERE id = ?').get(patientId)
      : null;
    if (!patient || !scheduledAt || !reasonText) {
      return res.status(400).json({ error: 'Patient, valid appointment time and reason are required.' });
    }
    if (reasonText.length > 240)
      return res.status(400).json({ error: 'Visit reason must be 240 characters or fewer.' });
    if (
      doctorId &&
      !db.prepare("SELECT id FROM users WHERE id = ? AND role = 'Doctor' AND active = 1").get(Number(doctorId))
    ) {
      return res.status(400).json({ error: 'Selected doctor is not valid.' });
    }

    const create = db.transaction(() => {
      const { queueNumber, queueOrder } = allocateQueueSlot(db, scheduledAt.slice(0, 10));
      const result = db
        .prepare(
          `INSERT INTO appointments(patient_id, doctor_id, scheduled_at, queue_number, queue_order, reason, created_by)
           VALUES(?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          patient.id,
          doctorId ? Number(doctorId) : null,
          scheduledAt,
          queueNumber,
          queueOrder,
          reasonText,
          req.user.id
        );
      audit(req, 'appointment_booked', 'appointment', result.lastInsertRowid, { queue_number: queueNumber });
      return { id: Number(result.lastInsertRowid), queue_number: queueNumber };
    });
    const created = create();
    events.publish('appointment.booked', {
      recordId: created.id,
      recordRef: `appointment:${created.id}`,
      patientId: patient.id,
      patientName: patient.full_name,
      queueNumber: created.queue_number
    });
    res.status(201).json(created);
  });

  router.patch('/appointments/:id/status', requireAuth, allow('Admin', 'Clinic Staff', 'Doctor'), (req, res) => {
    const row = db.prepare('SELECT * FROM appointments WHERE id = ?').get(Number(req.params.id));
    const status = req.body?.status;
    if (!row) return res.status(404).json({ error: 'Appointment not found.' });
    if (!TRANSITIONS[row.status]?.includes(status)) {
      return res.status(409).json({ error: `Cannot change appointment from ${row.status} to ${status}.` });
    }
    db.transaction(() => {
      db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, row.id);
      db.prepare('INSERT INTO queue_events(appointment_id, event_type, actor_id, details_json) VALUES(?, ?, ?, ?)').run(
        row.id,
        QUEUE_EVENT_FOR_STATUS[status],
        req.user.id,
        JSON.stringify({ from: row.status, to: status })
      );
      audit(req, 'appointment_status_changed', 'appointment', row.id, { from: row.status, to: status });
    })();
    res.json({ id: row.id, status });
  });

  return router;
};
