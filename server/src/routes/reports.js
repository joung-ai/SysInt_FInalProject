const express = require('express');
const { clinicDateString } = require('../lib/clinic');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

module.exports = function createReportsRouter({ db, requireAuth, allow }) {
  const router = express.Router();

  router.get('/reports', requireAuth, allow('Admin', 'Doctor', 'Clinic Staff'), (req, res) => {
    const today = clinicDateString();
    const weekAgo = clinicDateString(new Date(Date.now() - 6 * 86_400_000));
    const from = DATE_PATTERN.test(req.query.from || '') ? req.query.from : weekAgo;
    const to = DATE_PATTERN.test(req.query.to || '') ? req.query.to : today;
    if (from > to) return res.status(400).json({ error: 'The start date must be on or before the end date.' });
    const range = [from, to];
    const all = (sql, ...params) => db.prepare(sql).all(...params);

    res.json({
      from,
      to,
      appointments_by_status: all(
        `SELECT status, COUNT(*) AS count FROM appointments
         WHERE date(scheduled_at) BETWEEN date(?) AND date(?) GROUP BY status ORDER BY count DESC`,
        ...range
      ),
      appointments_by_day: all(
        `SELECT date(scheduled_at) AS day, COUNT(*) AS count,
                SUM(status = 'completed') AS completed, SUM(status = 'cancelled') AS cancelled
         FROM appointments WHERE date(scheduled_at) BETWEEN date(?) AND date(?)
         GROUP BY day ORDER BY day`,
        ...range
      ),
      consultations_by_status: all(
        `SELECT status, COUNT(*) AS count FROM consultations
         WHERE date(created_at) BETWEEN date(?) AND date(?) GROUP BY status ORDER BY count DESC`,
        ...range
      ),
      files_by_status: all(
        `SELECT v.status, COUNT(*) AS count FROM assets a
         JOIN asset_versions v ON v.asset_id = a.id AND v.version_number = a.current_version
         WHERE date(v.created_at) BETWEEN date(?) AND date(?) GROUP BY v.status ORDER BY count DESC`,
        ...range
      ),
      doctor_workload: all(
        `SELECT u.display_name AS doctor,
                (SELECT COUNT(*) FROM appointments a
                 WHERE a.doctor_id = u.id AND date(a.scheduled_at) BETWEEN date(?) AND date(?)) AS appointments,
                (SELECT COUNT(*) FROM consultations c
                 WHERE c.reviewed_by = u.id AND date(c.reviewed_at) BETWEEN date(?) AND date(?)) AS reviews
         FROM users u WHERE u.role = 'Doctor' ORDER BY u.display_name`,
        ...range,
        ...range
      ),
      notifications_by_channel: all(
        `SELECT channel, status, COUNT(*) AS count FROM notification_logs
         WHERE date(created_at) BETWEEN date(?) AND date(?) GROUP BY channel, status ORDER BY channel, status`,
        ...range
      ),
      integrations_by_status: all(
        `SELECT integration, status, COUNT(*) AS count FROM integration_logs
         WHERE date(created_at) BETWEEN date(?) AND date(?) GROUP BY integration, status ORDER BY integration, status`,
        ...range
      ),
      overdue_reviews: all(
        `SELECT c.id, p.full_name AS patient_name, c.updated_at,
                CAST((julianday('now') - julianday(c.updated_at)) * 24 AS INTEGER) AS hours_waiting
         FROM consultations c JOIN patients p ON p.id = c.patient_id
         WHERE c.status = 'submitted' AND c.updated_at < datetime('now', '-1 day')
         ORDER BY c.updated_at`
      ),
      missed_appointments: all(
        `SELECT a.id, p.full_name AS patient_name, a.scheduled_at, a.reason
         FROM appointments a JOIN patients p ON p.id = a.patient_id
         WHERE a.status = 'booked' AND a.scheduled_at < strftime('%Y-%m-%dT%H:%M', 'now', 'localtime', '-30 minutes')
         ORDER BY a.scheduled_at DESC LIMIT 50`
      )
    });
  });

  return router;
};
