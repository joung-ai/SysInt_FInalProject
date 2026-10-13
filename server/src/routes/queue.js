const express = require('express');
const crypto = require('node:crypto');
const { clinicDateString, clinicDateTime, ticketNumber, allocateQueueSlot } = require('../lib/clinic');

const SERVICES = new Set(['Vaccination', 'Checkup', 'Consultation', 'Laboratory']);
const STAFF = ['Admin', 'Doctor', 'Clinic Staff'];

module.exports = function createQueueRouter({ db, requireAuth, allow, audit, logNotification, events }) {
  const router = express.Router();

  function addQueueEvent(req, appointmentId, eventType, details = {}) {
    db.prepare('INSERT INTO queue_events(appointment_id, event_type, actor_id, details_json) VALUES(?, ?, ?, ?)').run(
      appointmentId,
      eventType,
      req.user?.id || null,
      JSON.stringify(details)
    );
  }

  const firstWithStatus = (date, status) =>
    db
      .prepare(
        `SELECT * FROM appointments WHERE date(scheduled_at) = date(?) AND status = ?
         ORDER BY COALESCE(queue_order, queue_number), id LIMIT 1`
      )
      .get(date, status);

  function getTodayRows(date = clinicDateString()) {
    return db
      .prepare(
        `SELECT a.id, a.patient_id, a.queue_number, a.scheduled_at, a.reason, a.status,
                p.full_name AS patient_name, p.mrn, p.phone
         FROM appointments a JOIN patients p ON p.id = a.patient_id
         WHERE date(a.scheduled_at) = date(?) AND a.status IN ('checked_in', 'in_consultation')
         ORDER BY CASE a.status WHEN 'in_consultation' THEN 0 ELSE 1 END, COALESCE(a.queue_order, a.queue_number), a.id`
      )
      .all(date);
  }

  function ticketView(row, includePatient = false) {
    if (!row) return null;
    return {
      id: row.id,
      ticket: ticketNumber(row.queue_number),
      queue_number: row.queue_number,
      service: row.reason,
      status: row.status,
      ...(includePatient
        ? { patient_id: row.patient_id, patient_name: row.patient_name, mrn: row.mrn, phone: row.phone }
        : {})
    };
  }

  // Tells the patient their number is being served (SMS only, when a phone number is on file).
  function announceCalled(appointment) {
    const patient = db.prepare('SELECT phone FROM patients WHERE id = ?').get(appointment.patient_id);
    events.publish('queue.patient_called', {
      recordId: appointment.id,
      recordRef: `appointment:${appointment.id}`,
      patientId: appointment.patient_id,
      ticket: ticketNumber(appointment.queue_number),
      hasPhone: Boolean(patient?.phone)
    });
  }

  router.post('/public/tickets', (req, res) => {
    const fullName = typeof req.body?.full_name === 'string' ? req.body.full_name.trim().replace(/\s+/g, ' ') : '';
    const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
    const service = typeof req.body?.service === 'string' ? req.body.service : '';
    if (fullName.length < 2 || fullName.length > 100)
      return res.status(400).json({ error: 'Enter a name between 2 and 100 characters.' });
    if (phone.length > 32) return res.status(400).json({ error: 'Phone number must be 32 characters or fewer.' });
    if (!SERVICES.has(service)) return res.status(400).json({ error: 'Choose one of the listed clinic services.' });

    // Public tickets use the active front-desk account as the appointment creator;
    // the immutable audit entry still records the actor as System/public intake.
    const staff = db
      .prepare("SELECT id FROM users WHERE role = 'Clinic Staff' AND active = 1 ORDER BY id LIMIT 1")
      .get();
    if (!staff) {
      return res
        .status(503)
        .json({ error: 'Public ticket registration is unavailable until demo staff accounts are seeded.' });
    }
    const date = clinicDateString();
    const createTicket = db.transaction(() => {
      let mrn;
      do {
        mrn = `ALQ-${date.replace(/-/g, '')}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      } while (db.prepare('SELECT 1 FROM patients WHERE mrn = ?').get(mrn));

      const patient = db
        .prepare('INSERT INTO patients(mrn, full_name, phone) VALUES(?, ?, ?)')
        .run(mrn, fullName, phone || null);
      const { queueNumber, queueOrder } = allocateQueueSlot(db, date);
      const appointment = db
        .prepare(
          `INSERT INTO appointments(patient_id, doctor_id, scheduled_at, queue_number, queue_order, reason, status, created_by)
           VALUES(?, NULL, ?, ?, ?, ?, 'checked_in', ?)`
        )
        .run(Number(patient.lastInsertRowid), clinicDateTime(), queueNumber, queueOrder, service, staff.id);
      const details = { queue_number: queueNumber, queue_order: queueOrder, service };
      addQueueEvent(req, appointment.lastInsertRowid, 'queue_ticket_created', details);
      audit(req, 'public_queue_ticket_created', 'appointment', appointment.lastInsertRowid, {
        patient_id: patient.lastInsertRowid,
        ...details
      });
      logNotification({
        patientId: patient.lastInsertRowid,
        eventType: 'queue_ticket_created',
        message: `Queue ticket ${ticketNumber(queueNumber)} created for ${service}.`,
        status: 'system'
      });
      const position = db
        .prepare(
          `SELECT COUNT(*) AS n FROM appointments
           WHERE date(scheduled_at) = date(?) AND status = 'checked_in' AND COALESCE(queue_order, queue_number) <= ?`
        )
        .get(date, queueOrder).n;
      return { ticket: ticketNumber(queueNumber), queue_number: queueNumber, service, position };
    });
    res.status(201).json(createTicket());
  });

  router.get('/public/queue-display', (_req, res) => {
    const rows = getTodayRows();
    const current = rows.find(row => row.status === 'in_consultation') || null;
    const waiting = rows.filter(row => row.status === 'checked_in');
    res.json({
      date: clinicDateString(),
      now_serving: ticketView(current),
      next_in_line: ticketView(waiting[0] || null),
      waiting: waiting.slice(0, 6).map((row, index) => ({ ...ticketView(row), position: index + 1 })),
      updated_at: new Date().toISOString()
    });
  });

  router.get('/queue/control', requireAuth, allow(...STAFF), (_req, res) => {
    const rows = getTodayRows();
    const current = rows.find(row => row.status === 'in_consultation') || null;
    res.json({
      date: clinicDateString(),
      now_serving: ticketView(current, true),
      waiting: rows.filter(row => row.status === 'checked_in').map(row => ticketView(row, true))
    });
  });

  router.post('/queue/control/next', requireAuth, allow(...STAFF), (req, res) => {
    const date = clinicDateString();
    const result = db.transaction(() => {
      const current = firstWithStatus(date, 'in_consultation');
      if (current) {
        db.prepare("UPDATE appointments SET status = 'completed' WHERE id = ?").run(current.id);
        addQueueEvent(req, current.id, 'queue_patient_completed');
        audit(req, 'queue_patient_completed', 'appointment', current.id, { queue_number: current.queue_number });
      }
      const completed = current ? ticketNumber(current.queue_number) : null;
      const waiting = firstWithStatus(date, 'checked_in');
      if (!waiting) return { current: null, completed, called: null };
      db.prepare("UPDATE appointments SET status = 'in_consultation' WHERE id = ?").run(waiting.id);
      addQueueEvent(req, waiting.id, 'queue_patient_called');
      audit(req, 'queue_patient_called', 'appointment', waiting.id, { queue_number: waiting.queue_number });
      return { current: ticketNumber(waiting.queue_number), completed, called: waiting };
    })();
    if (result.called) announceCalled(result.called);
    res.json({ current: result.current, completed: result.completed });
  });

  router.post('/queue/control/skip', requireAuth, allow(...STAFF), (req, res) => {
    const date = clinicDateString();
    const ticket = db.transaction(() => {
      const waiting = firstWithStatus(date, 'checked_in');
      if (!waiting) return null;
      const { queueOrder } = allocateQueueSlot(db, date);
      db.prepare('UPDATE appointments SET queue_order = ? WHERE id = ?').run(queueOrder, waiting.id);
      const details = { ticket: ticketNumber(waiting.queue_number), to_order: queueOrder };
      addQueueEvent(req, waiting.id, 'queue_patient_skipped', details);
      audit(req, 'queue_patient_skipped', 'appointment', waiting.id, details);
      return ticketNumber(waiting.queue_number);
    })();
    if (!ticket) return res.status(409).json({ error: 'There are no waiting patients to skip.' });
    res.json({ skipped_to_end: ticket });
  });

  router.post('/queue/control/recall', requireAuth, allow(...STAFF), (req, res) => {
    const date = clinicDateString();
    const previous = db.transaction(() => {
      const last = db
        .prepare(
          `SELECT a.* FROM queue_events e JOIN appointments a ON a.id = e.appointment_id
           WHERE date(a.scheduled_at) = date(?)
             AND e.event_type IN ('queue_patient_completed', 'queue_patient_skipped', 'manual_queue_completed')
             AND a.status IN ('checked_in', 'completed')
           ORDER BY e.id DESC LIMIT 1`
        )
        .get(date);
      if (!last) return null;
      const current = firstWithStatus(date, 'in_consultation');
      if (current && current.id !== last.id) {
        db.prepare("UPDATE appointments SET status = 'checked_in' WHERE id = ?").run(current.id);
        addQueueEvent(req, current.id, 'queue_service_replaced_by_recall', { recalled_appointment_id: last.id });
      }
      db.prepare("UPDATE appointments SET status = 'in_consultation' WHERE id = ?").run(last.id);
      addQueueEvent(req, last.id, 'queue_patient_recalled', { displaced_appointment_id: current?.id || null });
      audit(req, 'queue_patient_recalled', 'appointment', last.id, { queue_number: last.queue_number });
      return last;
    })();
    if (!previous)
      return res.status(409).json({ error: 'There is no recently skipped or completed patient to recall.' });
    announceCalled(previous);
    res.json({ recalled: ticketNumber(previous.queue_number) });
  });

  router.post('/queue/control/reset', requireAuth, allow('Admin'), (req, res) => {
    const date = clinicDateString();
    const closed = db.transaction(() => {
      const active = db
        .prepare(
          `SELECT id, queue_number FROM appointments
           WHERE date(scheduled_at) = date(?) AND status IN ('checked_in', 'in_consultation')`
        )
        .all(date);
      for (const row of active) {
        db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(row.id);
        addQueueEvent(req, row.id, 'daily_queue_reset');
      }
      audit(req, 'daily_queue_reset', 'queue', date, { closed_records: active.length });
      logNotification({
        eventType: 'daily_queue_reset',
        message: `Daily queue closed; ${active.length} active records retained in history.`,
        status: 'system'
      });
      return active.length;
    })();
    res.json({ closed_records: closed, history_retained: true });
  });

  return router;
};
