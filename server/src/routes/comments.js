const express = require('express');
const { doctorCanAccess, patientCanAccess } = require('../lib/access');

const ENTITY_TYPES = ['consultation', 'asset'];

module.exports = function createCommentsRouter({ db, requireAuth, audit, events }) {
  const router = express.Router();

  // Returns the record a comment thread belongs to, or null when it does not exist.
  function findEntity(entityType, entityId) {
    if (entityType === 'consultation') {
      return db
        .prepare(
          `SELECT c.id, c.patient_id, c.status, c.revision AS version, a.doctor_id, p.full_name AS patient_name,
                  'Consultation #' || c.id AS label
           FROM consultations c JOIN appointments a ON a.id = c.appointment_id JOIN patients p ON p.id = c.patient_id
           WHERE c.id = ?`
        )
        .get(entityId);
    }
    return db
      .prepare(
        `SELECT a.id, a.patient_id, v.status, a.current_version AS version, NULL AS doctor_id, p.full_name AS patient_name,
                'File #' || a.id || ' · ' || v.original_name AS label
         FROM assets a
         JOIN patients p ON p.id = a.patient_id
         JOIN asset_versions v ON v.asset_id = a.id AND v.version_number = a.current_version
         WHERE a.id = ?`
      )
      .get(entityId);
  }

  const canAccess = (user, entity) =>
    patientCanAccess(user, entity.patient_id) && doctorCanAccess(user, entity.doctor_id);

  router.get('/comments', requireAuth, (req, res) => {
    const { entity_type: entityType } = req.query;
    if (entityType) {
      const entityId = Number(req.query.entity_id);
      if (!ENTITY_TYPES.includes(entityType) || !Number.isInteger(entityId)) {
        return res.status(400).json({ error: 'entity_type must be consultation or asset, with a numeric entity_id.' });
      }
      const entity = findEntity(entityType, entityId);
      if (!entity) return res.status(404).json({ error: 'Record not found.' });
      if (!canAccess(req.user, entity)) return res.status(403).json({ error: 'You cannot access this record.' });
      const comments = db
        .prepare(
          `SELECT cm.*, u.display_name AS author_name, u.role AS author_role
           FROM comments cm JOIN users u ON u.id = cm.author_id
           WHERE cm.entity_type = ? AND cm.entity_id = ? ORDER BY cm.id`
        )
        .all(entityType, entityId);
      return res.json({ entity: { type: entityType, ...entity }, comments });
    }

    // Recent feedback across every record the user may see.
    let sql = `SELECT cm.*, u.display_name AS author_name, u.role AS author_role,
                      COALESCE(c.patient_id, a.patient_id) AS patient_id, p.full_name AS patient_name
               FROM comments cm
               JOIN users u ON u.id = cm.author_id
               LEFT JOIN consultations c ON cm.entity_type = 'consultation' AND c.id = cm.entity_id
               LEFT JOIN appointments ap ON ap.id = c.appointment_id
               LEFT JOIN assets a ON cm.entity_type = 'asset' AND a.id = cm.entity_id
               JOIN patients p ON p.id = COALESCE(c.patient_id, a.patient_id)
               WHERE 1 = 1`;
    const params = [];
    if (req.user.role === 'Patient') {
      sql += ' AND p.id = ?';
      params.push(req.user.patient_id);
    }
    if (req.user.role === 'Doctor') {
      sql += " AND (cm.entity_type = 'asset' OR ap.doctor_id IS NULL OR ap.doctor_id = ?)";
      params.push(req.user.id);
    }
    sql += ' ORDER BY cm.id DESC LIMIT 200';
    res.json({ comments: db.prepare(sql).all(...params) });
  });

  router.post('/comments', requireAuth, (req, res) => {
    const { entity_type: entityType } = req.body || {};
    const entityId = Number(req.body?.entity_id);
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!ENTITY_TYPES.includes(entityType) || !Number.isInteger(entityId)) {
      return res.status(400).json({ error: 'entity_type must be consultation or asset, with a numeric entity_id.' });
    }
    if (!body || body.length > 2000)
      return res.status(400).json({ error: 'Comment must be between 1 and 2000 characters.' });
    const entity = findEntity(entityType, entityId);
    if (!entity) return res.status(404).json({ error: 'Record not found.' });
    if (!canAccess(req.user, entity)) return res.status(403).json({ error: 'You cannot comment on this record.' });

    const result = db
      .prepare(
        `INSERT INTO comments(entity_type, entity_id, version_number, author_id, kind, body)
         VALUES(?, ?, ?, ?, 'comment', ?)`
      )
      .run(entityType, entityId, entity.version, req.user.id, body);
    audit(req, 'comment_added', entityType, entityId, { comment_id: Number(result.lastInsertRowid) });
    events.publish('comment.added', {
      recordId: entityId,
      recordRef: `${entityType}:${entityId}`,
      patientId: entity.patient_id,
      entityType,
      authorRole: req.user.role,
      body: body.slice(0, 160)
    });
    res.status(201).json({ id: Number(result.lastInsertRowid), entity_type: entityType, entity_id: entityId });
  });

  return router;
};
