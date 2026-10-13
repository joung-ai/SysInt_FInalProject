const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const db = require('./db');
const createEventBus = require('./services/eventBus');
const createNotifier = require('./services/notifier');
const registerWorkflowSubscribers = require('./services/workflowSubscribers');
const createAccountsRouter = require('./routes/accounts');
const createAppointmentsRouter = require('./routes/appointments');
const createAssetsRouter = require('./routes/assets');
const createCommentsRouter = require('./routes/comments');
const createConsultationsRouter = require('./routes/consultations');
const createIntegrationsRouter = require('./routes/integrations');
const createQueueRouter = require('./routes/queue');
const createReportsRouter = require('./routes/reports');
const createSystemRouter = require('./routes/system');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, '..', 'public');
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(ROOT, 'uploads'));
const EXPORT_DIR = path.resolve(process.env.EXPORT_DIR || path.join(ROOT, 'exports', 'philhealth'));
const PORT = Number(process.env.PORT || 3000);
const GATEWAY_PORT = Number(process.env.SMS_GATEWAY_PORT || 5051);
const SMS_URL = process.env.SMS_GATEWAY_URL || `http://127.0.0.1:${GATEWAY_PORT}/sms`;
const EMAIL_URL = process.env.EMAIL_GATEWAY_URL || `http://127.0.0.1:${GATEWAY_PORT}/email`;
const JWT_SECRET = process.env.JWT_SECRET || 'development-only-change-this-secret';
const ROLES = ['Admin', 'Doctor', 'Clinic Staff', 'Patient'];

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('Set JWT_SECRET before running in production.');
}
const validPort = value => Number.isInteger(value) && value >= 1 && value <= 65535;
if (!validPort(PORT) || !validPort(GATEWAY_PORT)) throw new Error('PORT and SMS_GATEWAY_PORT must be valid TCP ports.');
if (PORT === GATEWAY_PORT) throw new Error('PORT and SMS_GATEWAY_PORT must be different.');

for (const dir of [UPLOAD_DIR, EXPORT_DIR, path.join(ROOT, 'data')]) fs.mkdirSync(dir, { recursive: true });

const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function audit(req, action, entityType, entityId, details = {}) {
  db.prepare(
    `INSERT INTO audit_logs(actor_id, actor_role, action, entity_type, entity_id, details_json, ip_address)
     VALUES(?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.user?.id || null,
    req.user?.role || 'System',
    action,
    entityType,
    entityId == null ? null : String(entityId),
    JSON.stringify(details),
    req.ip || null
  );
}

function logNotification({
  patientId = null,
  channel = 'system',
  eventType,
  message,
  destination = null,
  status = 'system',
  responseBody = '',
  recipientRole = null,
  transactionId = null
}) {
  db.prepare(
    `INSERT INTO notification_logs(patient_id, channel, event_type, message, destination, status, response_body,
       recipient_role, transaction_id)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    patientId,
    channel,
    eventType,
    message,
    destination,
    status,
    String(responseBody).slice(0, 2000),
    recipientRole,
    transactionId
  );
}

function logIntegration({
  transactionId = crypto.randomUUID(),
  integration,
  action,
  status,
  recordRef = null,
  payload = {},
  errorMessage = null
}) {
  db.prepare(
    `INSERT INTO integration_logs(transaction_id, integration, action, status, record_ref, payload_json, error_message)
     VALUES(?, ?, ?, ?, ?, ?, ?)`
  ).run(
    transactionId,
    integration,
    action,
    status,
    recordRef == null ? null : String(recordRef),
    JSON.stringify(payload).slice(0, 4000),
    errorMessage
  );
  return transactionId;
}

function requireAuth(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Authentication required.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db
      .prepare('SELECT id, username, role, display_name, patient_id, active FROM users WHERE id = ?')
      .get(payload.sub);
    if (!user || !user.active || user.role !== payload.role) {
      return res.status(401).json({ error: 'Session is no longer valid.' });
    }
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }
}

const allow =
  (...roles) =>
  (req, res, next) =>
    roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Your role cannot perform this action.' });

const events = createEventBus({ logIntegration });
const notifier = createNotifier({ db, logNotification, logIntegration, smsUrl: SMS_URL, emailUrl: EMAIL_URL });
registerWorkflowSubscribers({ bus: events, notifier });

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, UPLOAD_DIR),
  filename: (_req, file, callback) =>
    callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!new Set(['.pdf', '.png', '.jpg', '.jpeg']).has(ext)) {
      const error = new Error('Only PDF, PNG and JPEG files are accepted.');
      error.status = 400;
      return callback(error);
    }
    callback(null, true);
  }
});

const app = express();
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.get('/api/health', (_req, res) =>
  res.json({ ok: true, service: 'healthcare-integration-api', time: new Date().toISOString() })
);

const context = { db, requireAuth, allow, audit, logNotification, logIntegration, asyncRoute, events };
app.use('/api', createAccountsRouter({ ...context, bcrypt, jwt, jwtSecret: JWT_SECRET, roles: ROLES }));
app.use('/api', createAppointmentsRouter(context));
app.use('/api', createConsultationsRouter(context));
app.use('/api', createAssetsRouter({ ...context, upload, uploadDir: UPLOAD_DIR }));
app.use('/api', createCommentsRouter(context));
app.use('/api', createIntegrationsRouter({ ...context, exportDir: EXPORT_DIR }));
app.use('/api', createReportsRouter(context));
app.use('/api', createSystemRouter(context));
app.use('/api', createQueueRouter(context));
app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.get('/', (_req, res) => res.redirect('/login.html'));
app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err instanceof multer.MulterError ? 400 : Number(err.status) || 500;
  res.status(status).json({ error: status === 500 ? 'Unexpected server error.' : err.message });
});

// Loopback-only service that simulates the external SMS and email providers used by notifications.
const gateway = express();
gateway.use(express.json({ limit: '16kb' }));
for (const channel of ['sms', 'email']) {
  gateway.post(`/${channel}`, (req, res) => {
    if (!req.body?.to || !req.body?.message) {
      return res.status(400).json({ accepted: false, error: 'to and message are required' });
    }
    console.log(`[LOCAL ${channel.toUpperCase()} MOCK] to=${req.body.to} event=${req.body.eventType || 'notice'}`);
    res.json({ accepted: true, provider: `local-${channel}-mock`, message_id: crypto.randomUUID() });
  });
}

if (require.main === module) {
  gateway.listen(GATEWAY_PORT, '127.0.0.1', () =>
    console.log(`Local SMS/email gateway listening on 127.0.0.1:${GATEWAY_PORT}`)
  );
  app.listen(PORT, () => console.log(`Healthcare system listening at http://localhost:${PORT}`));
}

module.exports = { app, gateway };
