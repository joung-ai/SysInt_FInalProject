const express = require('express');
const { clinicDateString } = require('../lib/clinic');

module.exports = function createAccountsRouter({
  db,
  requireAuth,
  allow,
  audit,
  bcrypt,
  jwt,
  jwtSecret,
  roles,
  asyncRoute
}) {
  const router = express.Router();

  router.post(
    '/auth/login',
    asyncRoute(async (req, res) => {
      const { username, password, role } = req.body || {};
      if (!username || !password || !roles.includes(role)) {
        return res.status(400).json({ error: 'Username, password and a valid role are required.' });
      }
      const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username).trim());
      const passwordMatches = user && (await bcrypt.compare(String(password), user.password_hash));
      if (!user || !user.active || user.role !== role || !passwordMatches) {
        return res.status(401).json({ error: 'Invalid username, password, or selected role.' });
      }
      const token = jwt.sign({ sub: user.id, role: user.role }, jwtSecret, { expiresIn: '8h' });
      req.user = user;
      audit(req, 'login', 'session', user.id);
      res.json({
        token,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          display_name: user.display_name,
          patient_id: user.patient_id
        }
      });
    })
  );

  router.get('/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

  router.get('/users', requireAuth, allow('Admin'), (_req, res) => {
    res.json(
      db
        .prepare(
          `SELECT u.id, u.username, u.role, u.display_name, u.patient_id, u.active, u.created_at,
                  p.full_name AS patient_name, p.mrn
           FROM users u LEFT JOIN patients p ON p.id = u.patient_id
           ORDER BY u.display_name`
        )
        .all()
    );
  });

  router.post(
    '/users',
    requireAuth,
    allow('Admin'),
    asyncRoute(async (req, res) => {
      const { username, password, role, display_name: displayName, patient_id: patientId = null } = req.body || {};
      const name = String(username || '').trim();
      if (name.length < 3 || String(password || '').length < 8 || !roles.includes(role) || !displayName) {
        return res
          .status(400)
          .json({ error: 'Provide a username (3+ characters), password (8+ characters), name and valid role.' });
      }
      if (role === 'Patient' && !db.prepare('SELECT id FROM patients WHERE id = ?').get(Number(patientId))) {
        return res.status(400).json({ error: 'A valid patient record is required for a Patient account.' });
      }
      try {
        const result = db
          .prepare('INSERT INTO users(username, password_hash, role, display_name, patient_id) VALUES(?, ?, ?, ?, ?)')
          .run(
            name,
            await bcrypt.hash(String(password), 10),
            role,
            String(displayName).trim(),
            role === 'Patient' ? Number(patientId) : null
          );
        audit(req, 'user_created', 'user', result.lastInsertRowid, { role });
        res
          .status(201)
          .json({ id: result.lastInsertRowid, username: name, role, display_name: String(displayName).trim() });
      } catch (error) {
        if (String(error.code).includes('CONSTRAINT'))
          return res.status(409).json({ error: 'That username already exists.' });
        throw error;
      }
    })
  );

  router.patch('/users/:id/status', requireAuth, allow('Admin'), (req, res) => {
    const user = db.prepare('SELECT id, active FROM users WHERE id = ?').get(Number(req.params.id));
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (typeof req.body?.active !== 'boolean') return res.status(400).json({ error: 'active must be true or false.' });
    if (user.id === req.user.id)
      return res.status(409).json({ error: 'You cannot change the status of your own account.' });
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, user.id);
    audit(req, req.body.active ? 'user_activated' : 'user_deactivated', 'user', user.id);
    res.json({ id: user.id, active: req.body.active });
  });

  router.get('/doctors', requireAuth, (_req, res) => {
    res.json(
      db.prepare("SELECT id, display_name FROM users WHERE role = 'Doctor' AND active = 1 ORDER BY display_name").all()
    );
  });

  router.get('/patients', requireAuth, (req, res) => {
    const columns = 'id, mrn, full_name, date_of_birth, phone, email';
    const rows =
      req.user.role === 'Patient'
        ? db.prepare(`SELECT ${columns} FROM patients WHERE id = ?`).all(req.user.patient_id)
        : db.prepare(`SELECT ${columns} FROM patients ORDER BY full_name`).all();
    res.json(rows);
  });

  router.get('/dashboard', requireAuth, (req, res) => {
    const date = req.query.date || clinicDateString();
    const isPatient = req.user.role === 'Patient';
    const patientFilter = isPatient ? ' AND patient_id = ?' : '';
    const args = isPatient ? [date, req.user.patient_id] : [date];
    const count = (sql, ...params) => db.prepare(sql).get(...params).n;

    const appointmentCount = count(
      `SELECT COUNT(*) AS n FROM appointments WHERE date(scheduled_at) = date(?) AND status <> 'cancelled'${patientFilter}`,
      ...args
    );
    const queueCount = count(
      `SELECT COUNT(*) AS n FROM appointments
       WHERE date(scheduled_at) = date(?) AND status IN ('checked_in', 'in_consultation')${patientFilter}`,
      ...args
    );
    const scope = isPatient ? ' AND patient_id = ?' : '';
    const scopeArgs = isPatient ? [req.user.patient_id] : [];
    const pendingReviews = count(
      `SELECT COUNT(*) AS n FROM consultations WHERE status = 'submitted'${scope}`,
      ...scopeArgs
    );
    const revisionRequests = count(
      `SELECT COUNT(*) AS n FROM consultations WHERE status = 'revision_requested'${scope}`,
      ...scopeArgs
    );
    const pendingFiles = count(
      `SELECT COUNT(*) AS n FROM assets a JOIN asset_versions v ON v.asset_id = a.id AND v.version_number = a.current_version
       WHERE v.status IN ('uploaded', 'revised')${isPatient ? ' AND a.patient_id = ?' : ''}`,
      ...scopeArgs
    );
    const overdueReviews = count(
      `SELECT COUNT(*) AS n FROM consultations WHERE status = 'submitted' AND updated_at < datetime('now', '-1 day')${scope}`,
      ...scopeArgs
    );
    const failedIntegrations = isPatient
      ? 0
      : count(
          "SELECT COUNT(*) AS n FROM integration_logs WHERE status = 'failed' AND created_at >= datetime('now', '-1 day')"
        );

    res.json({
      date,
      appointment_count: appointmentCount,
      active_queue_count: queueCount,
      pending_reviews: pendingReviews,
      pending_file_reviews: pendingFiles,
      revision_requests: revisionRequests,
      overdue_reviews: overdueReviews,
      failed_integrations_24h: failedIntegrations,
      patients: isPatient ? 1 : count('SELECT COUNT(*) AS n FROM patients'),
      api: 'online',
      database: 'connected'
    });
  });

  return router;
};
