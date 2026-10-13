const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { patientCanAccess } = require('../lib/access');

const CATEGORIES = ['Lab result', 'Prescription', 'Imaging', 'Referral', 'Medical certificate', 'Other'];
const DECISIONS = ['approved', 'rejected', 'revision_requested'];
const REVIEWABLE = ['uploaded', 'revised'];

module.exports = function createAssetsRouter({ db, requireAuth, allow, audit, asyncRoute, events, upload, uploadDir }) {
  const router = express.Router();

  const safeFileName = name =>
    path
      .basename(name)
      .replace(/[\r\n\0]/g, '')
      .slice(0, 240) || 'uploaded-file';

  router.get('/assets', requireAuth, (req, res) => {
    let sql = `SELECT a.id AS asset_id, a.patient_id, a.category, p.full_name AS patient_name, a.current_version, a.created_at,
                      v.id AS version_id, v.version_number, v.original_name, v.mime_type, v.size_bytes, v.status, v.comment,
                      v.created_at AS version_created_at, u.display_name AS uploader_name, r.display_name AS reviewer_name
               FROM assets a
               JOIN patients p ON p.id = a.patient_id
               JOIN asset_versions v ON v.asset_id = a.id
               JOIN users u ON u.id = v.uploaded_by
               LEFT JOIN users r ON r.id = v.approved_by
               WHERE 1 = 1`;
    const params = [];
    if (req.user.role === 'Patient') {
      sql += ' AND a.patient_id = ?';
      params.push(req.user.patient_id);
    }
    if (req.query.patient_id) {
      sql += ' AND a.patient_id = ?';
      params.push(Number(req.query.patient_id));
    }
    sql += ' ORDER BY a.id DESC, v.version_number DESC';
    res.json(db.prepare(sql).all(...params));
  });

  router.post(
    '/assets',
    requireAuth,
    allow('Admin', 'Doctor', 'Clinic Staff', 'Patient'),
    upload.single('file'),
    (req, res) => {
      const file = req.file;
      const reject = (status, error) => {
        if (file?.path) fs.rmSync(file.path, { force: true });
        return res.status(status).json({ error });
      };
      try {
        if (!file) return reject(400, 'Choose a file to upload.');
        const patientId = Number(req.user.role === 'Patient' ? req.user.patient_id : req.body.patient_id);
        const patient = Number.isFinite(patientId)
          ? db.prepare('SELECT id, full_name FROM patients WHERE id = ?').get(patientId)
          : null;
        if (!patient) return reject(400, 'A valid patient is required.');
        const category = req.body.category || 'Other';
        if (!CATEGORIES.includes(category)) return reject(400, `Category must be one of: ${CATEGORIES.join(', ')}.`);

        let assetId = req.body.asset_id ? Number(req.body.asset_id) : null;
        if (req.body.asset_id && (!Number.isInteger(assetId) || assetId < 1)) {
          return reject(400, 'Asset ID must be a positive integer.');
        }
        if (assetId) {
          const existing = db.prepare('SELECT patient_id FROM assets WHERE id = ?').get(assetId);
          if (!existing || existing.patient_id !== patient.id)
            return reject(404, 'Asset does not belong to this patient.');
        }

        const created = db.transaction(() => {
          let version = 1;
          if (!assetId) {
            const inserted = db
              .prepare('INSERT INTO assets(patient_id, uploaded_by, category) VALUES(?, ?, ?)')
              .run(patient.id, req.user.id, category);
            assetId = Number(inserted.lastInsertRowid);
          } else {
            version = db.prepare('SELECT current_version + 1 AS n FROM assets WHERE id = ?').get(assetId).n;
          }
          const status = version === 1 ? 'uploaded' : 'revised';
          const originalName = safeFileName(file.originalname);
          const result = db
            .prepare(
              `INSERT INTO asset_versions(asset_id, version_number, original_name, storage_name, mime_type, size_bytes, status, uploaded_by)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(assetId, version, originalName, file.filename, file.mimetype, file.size, status, req.user.id);
          db.prepare('UPDATE assets SET current_version = ? WHERE id = ?').run(version, assetId);
          audit(req, version === 1 ? 'asset_uploaded' : 'asset_revised', 'asset', assetId, {
            version,
            original_name: originalName
          });
          return { asset_id: assetId, version_id: Number(result.lastInsertRowid), version_number: version, status };
        })();

        events.publish(created.version_number === 1 ? 'asset.uploaded' : 'asset.revised', {
          recordId: created.asset_id,
          recordRef: `asset:${created.asset_id}`,
          patientId: patient.id,
          patientName: patient.full_name,
          version: created.version_number
        });
        res.status(201).json(created);
      } catch (error) {
        if (file?.path) fs.rmSync(file.path, { force: true });
        throw error;
      }
    }
  );

  async function reviewCurrentVersion(req, res, decision) {
    const asset = db
      .prepare(
        'SELECT a.*, p.full_name AS patient_name FROM assets a JOIN patients p ON p.id = a.patient_id WHERE a.id = ?'
      )
      .get(Number(req.params.id));
    if (!asset) return res.status(404).json({ error: 'Asset not found.' });
    const version = db
      .prepare('SELECT * FROM asset_versions WHERE asset_id = ? AND version_number = ?')
      .get(asset.id, asset.current_version);
    if (!version || !REVIEWABLE.includes(version.status)) {
      return res.status(409).json({ error: 'The current version cannot be reviewed.' });
    }
    if (!DECISIONS.includes(decision)) {
      return res.status(400).json({ error: 'Decision must be approved, rejected or revision_requested.' });
    }
    const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : '';
    if (!comment) return res.status(400).json({ error: 'Add a doctor comment before recording the file review.' });

    db.transaction(() => {
      db.prepare('UPDATE asset_versions SET status = ?, approved_by = ?, comment = ? WHERE id = ?').run(
        decision,
        req.user.id,
        comment,
        version.id
      );
      db.prepare(
        `INSERT INTO comments(entity_type, entity_id, version_number, author_id, kind, decision, body)
         VALUES('asset', ?, ?, ?, 'review', ?, ?)`
      ).run(asset.id, version.version_number, req.user.id, decision, comment);
      audit(req, `asset_${decision}`, 'asset', asset.id, { version: version.version_number, comment });
    })();

    const event = await events.publish(`asset.${decision}`, {
      recordId: asset.id,
      recordRef: `asset:${asset.id}`,
      patientId: asset.patient_id,
      patientName: asset.patient_name,
      version: version.version_number,
      comment
    });
    const delivery = event.results.patientGateway || {};
    res.json({
      asset_id: asset.id,
      version_number: version.version_number,
      status: decision,
      sms: delivery.sms || null,
      email: delivery.email || null,
      transaction_id: event.transactionId
    });
  }

  router.post(
    '/assets/:id/review',
    requireAuth,
    allow('Doctor'),
    asyncRoute((req, res) => reviewCurrentVersion(req, res, req.body?.decision))
  );

  // Kept for API compatibility: approval with a required comment.
  router.post(
    '/assets/:id/approve',
    requireAuth,
    allow('Doctor'),
    asyncRoute((req, res) => reviewCurrentVersion(req, res, 'approved'))
  );

  router.get('/assets/:id/download/:version', requireAuth, (req, res) => {
    const version = db
      .prepare(
        `SELECT v.*, a.patient_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id
         WHERE a.id = ? AND v.version_number = ?`
      )
      .get(Number(req.params.id), Number(req.params.version));
    if (!version) return res.status(404).json({ error: 'File version not found.' });
    if (!patientCanAccess(req.user, version.patient_id))
      return res.status(403).json({ error: 'You cannot access this file.' });
    const filePath = path.join(uploadDir, path.basename(version.storage_name));
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Stored file is missing.' });
    audit(req, 'asset_downloaded', 'asset', version.asset_id, { version: version.version_number });
    res.download(filePath, version.original_name);
  });

  return router;
};
