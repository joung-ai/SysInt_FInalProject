const express = require('express');
const { doctorCanAccess } = require('../lib/access');

const DECISIONS = ['approved', 'rejected', 'revision_requested'];
const text = value => (typeof value === 'string' ? value.trim() : '');

module.exports = function createConsultationsRouter({ db, requireAuth, allow, audit, asyncRoute, events }) {
  const router = express.Router();

  const findConsultation = id =>
    db
      .prepare(
        `SELECT c.*, a.doctor_id, p.full_name AS patient_name
         FROM consultations c
         JOIN appointments a ON a.id = c.appointment_id
         JOIN patients p ON p.id = c.patient_id
         WHERE c.id = ?`
      )
      .get(Number(id));

  router.get('/consultations', requireAuth, (req, res) => {
    let sql = `SELECT c.*, p.full_name AS patient_name, p.mrn, a.scheduled_at, a.queue_number, a.doctor_id,
                      u.display_name AS submitter_name, d.display_name AS doctor_name
               FROM consultations c
               JOIN patients p ON p.id = c.patient_id
               JOIN appointments a ON a.id = c.appointment_id
               JOIN users u ON u.id = c.submitted_by
               LEFT JOIN users d ON d.id = a.doctor_id
               WHERE 1 = 1`;
    const params = [];
    if (req.user.role === 'Patient') {
      sql += ' AND c.patient_id = ?';
      params.push(req.user.patient_id);
    }
    if (req.user.role === 'Doctor') {
      sql += ' AND (a.doctor_id IS NULL OR a.doctor_id = ?)';
      params.push(req.user.id);
    }
    if (req.query.status) {
      sql += ' AND c.status = ?';
      params.push(req.query.status);
    }
    sql += ' ORDER BY c.updated_at DESC, c.id DESC';
    res.json(db.prepare(sql).all(...params));
  });

  router.post('/consultations', requireAuth, allow('Admin', 'Clinic Staff'), (req, res) => {
    const { appointment_id: appointmentId } = req.body || {};
    const symptoms = text(req.body?.symptoms);
    const notes = text(req.body?.clinical_notes);
    const appointment = db
      .prepare(
        'SELECT a.*, p.full_name AS patient_name FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = ?'
      )
      .get(Number(appointmentId));
    if (!appointment || !['checked_in', 'in_consultation'].includes(appointment.status) || !symptoms) {
      return res.status(400).json({ error: 'A checked-in appointment and symptoms are required.' });
    }
    if (symptoms.length > 4000 || notes.length > 4000) {
      return res.status(400).json({ error: 'Symptoms and notes must be 4000 characters or fewer.' });
    }
    let id;
    try {
      id = db.transaction(() => {
        const result = db
          .prepare(
            `INSERT INTO consultations(appointment_id, patient_id, submitted_by, symptoms, clinical_notes, status)
             VALUES(?, ?, ?, ?, ?, 'submitted')`
          )
          .run(appointment.id, appointment.patient_id, req.user.id, symptoms, notes);
        audit(req, 'consultation_submitted', 'consultation', result.lastInsertRowid, {
          appointment_id: appointment.id
        });
        return Number(result.lastInsertRowid);
      })();
    } catch (error) {
      if (String(error.code).includes('CONSTRAINT')) {
        return res.status(409).json({ error: 'This appointment already has a consultation record.' });
      }
      throw error;
    }
    events.publish('consultation.submitted', {
      recordId: id,
      recordRef: `consultation:${id}`,
      patientId: appointment.patient_id,
      patientName: appointment.patient_name
    });
    res.status(201).json({ id, status: 'submitted' });
  });

  // Staff answer a doctor's revision request by correcting the record and sending it back for review.
  router.put('/consultations/:id', requireAuth, allow('Admin', 'Clinic Staff'), (req, res) => {
    const row = findConsultation(req.params.id);
    if (!row) return res.status(404).json({ error: 'Consultation not found.' });
    if (row.status !== 'revision_requested') {
      return res.status(409).json({ error: 'Only consultations with a revision request can be resubmitted.' });
    }
    const symptoms = text(req.body?.symptoms);
    const notes = text(req.body?.clinical_notes);
    const note = text(req.body?.revision_note);
    if (!symptoms) return res.status(400).json({ error: 'Symptoms are required.' });
    if (symptoms.length > 4000 || notes.length > 4000 || note.length > 4000) {
      return res.status(400).json({ error: 'Symptoms, notes and revision note must be 4000 characters or fewer.' });
    }
    const revision = row.revision + 1;
    db.transaction(() => {
      db.prepare(
        `UPDATE consultations
         SET symptoms = ?, clinical_notes = ?, status = 'submitted', revision = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(symptoms, notes, revision, row.id);
      if (note) {
        db.prepare(
          `INSERT INTO comments(entity_type, entity_id, version_number, author_id, kind, body)
           VALUES('consultation', ?, ?, ?, 'revision_note', ?)`
        ).run(row.id, revision, req.user.id, note);
      }
      audit(req, 'consultation_resubmitted', 'consultation', row.id, { revision });
    })();
    events.publish('consultation.resubmitted', {
      recordId: row.id,
      recordRef: `consultation:${row.id}`,
      patientId: row.patient_id,
      patientName: row.patient_name,
      revision
    });
    res.json({ id: row.id, status: 'submitted', revision });
  });

  router.post(
    '/consultations/:id/review',
    requireAuth,
    allow('Doctor'),
    asyncRoute(async (req, res) => {
      const row = findConsultation(req.params.id);
      const decision = req.body?.decision;
      const comment = text(req.body?.comment);
      if (!row) return res.status(404).json({ error: 'Consultation not found.' });
      if (!doctorCanAccess(req.user, row.doctor_id)) {
        return res.status(403).json({ error: 'This consultation is assigned to another doctor.' });
      }
      if (row.status !== 'submitted')
        return res.status(409).json({ error: 'Only submitted consultations can be reviewed.' });
      if (!DECISIONS.includes(decision)) {
        return res.status(400).json({ error: 'Decision must be approved, rejected or revision_requested.' });
      }
      if (!comment)
        return res.status(400).json({ error: 'Add a doctor comment before recording the review decision.' });

      db.transaction(() => {
        db.prepare(
          `UPDATE consultations
           SET status = ?, doctor_comment = ?, reviewed_by = ?, reviewed_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ?`
        ).run(decision, comment, req.user.id, row.id);
        db.prepare(
          `INSERT INTO comments(entity_type, entity_id, version_number, author_id, kind, decision, body)
           VALUES('consultation', ?, ?, ?, 'review', ?, ?)`
        ).run(row.id, row.revision, req.user.id, decision, comment);
        audit(req, `consultation_${decision}`, 'consultation', row.id, { comment, revision: row.revision });
      })();

      const event = await events.publish(`consultation.${decision}`, {
        recordId: row.id,
        recordRef: `consultation:${row.id}`,
        patientId: row.patient_id,
        patientName: row.patient_name,
        comment
      });
      const delivery = event.results.patientGateway || {};
      res.json({
        id: row.id,
        status: decision,
        sms: delivery.sms || null,
        email: delivery.email || null,
        transaction_id: event.transactionId
      });
    })
  );

  return router;
};
