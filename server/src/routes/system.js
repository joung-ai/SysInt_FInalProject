const express = require('express');

module.exports = function createSystemRouter({ db, requireAuth, allow }) {
  const router = express.Router();

  // Admin sees every notification; patients see deliveries addressed to them; doctors and clinic
  // staff see the in-app alerts addressed to their role.
  router.get('/notifications', requireAuth, (req, res) => {
    let rows;
    if (req.user.role === 'Admin') {
      rows = db.prepare('SELECT * FROM notification_logs ORDER BY id DESC LIMIT 1000').all();
    } else if (req.user.role === 'Patient') {
      rows = db
        .prepare(
          `SELECT * FROM notification_logs
           WHERE patient_id = ? AND (recipient_role IS NULL OR recipient_role = 'Patient')
           ORDER BY id DESC LIMIT 500`
        )
        .all(req.user.patient_id);
    } else {
      rows = db
        .prepare('SELECT * FROM notification_logs WHERE recipient_role = ? ORDER BY id DESC LIMIT 500')
        .all(req.user.role);
    }
    res.json(rows);
  });

  router.get('/audit', requireAuth, allow('Admin'), (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 250, 1), 1000);
    let sql =
      'SELECT a.*, u.username, u.display_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id WHERE 1 = 1';
    const params = [];
    if (req.query.action) {
      sql += ' AND a.action LIKE ?';
      params.push(`%${req.query.action}%`);
    }
    sql += ' ORDER BY a.id DESC LIMIT ?';
    res.json(db.prepare(sql).all(...params, limit));
  });

  return router;
};
