const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const Database = require('better-sqlite3');

const serverRoot = path.resolve(__dirname, '..');
const publicRoot = path.resolve(serverRoot, '..', 'public');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carelink-system-test-'));
const runtimeRoot = path.join(tempRoot, 'runtime');
const testDatabase = path.join(runtimeRoot, 'healthcare.sqlite');
const uploadRoot = path.join(runtimeRoot, 'uploads');
const exportRoot = path.join(runtimeRoot, 'exports', 'philhealth');
const backupRoot = path.join(tempRoot, 'backup-snapshot');
let child;
let baseUrl;
let port;
let tokens = {};
let patients = [];
let appointmentId;
let consultationId;
let assetId;

function localDateTime(offsetMinutes = 90) {
  const date = new Date(Date.now() + offsetMinutes * 60_000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function api(route, { token, method = 'GET', body, headers = {} } = {}) {
  const requestHeaders = new Headers(headers);
  if (token) requestHeaders.set('authorization', `Bearer ${token}`);
  const options = { method, headers: requestHeaders };
  if (body !== undefined) {
    if (body instanceof FormData) options.body = body;
    else {
      requestHeaders.set('content-type', 'application/json');
      options.body = JSON.stringify(body);
    }
  }
  const response = await fetch(`${baseUrl}${route}`, options);
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, data };
}

async function uploadFile(patientId, { asset = null, filename = 'clinic-report.pdf' } = {}) {
  const form = new FormData();
  form.append('patient_id', String(patientId));
  if (asset) form.append('asset_id', String(asset));
  form.append('file', new Blob([Buffer.from('%PDF-1.4 CareLink test fixture')], { type: 'application/pdf' }), filename);
  return api('/api/assets', { token: tokens.staff, method: 'POST', body: form });
}

async function makeConsultation(patientId, reason) {
  const booking = await api('/api/appointments', {
    token: tokens.staff,
    method: 'POST',
    body: {
      patient_id: patientId,
      scheduled_at: localDateTime(),
      reason
    }
  });
  assert.equal(booking.response.status, 201);
  const checkedIn = await api(`/api/appointments/${booking.data.id}/status`, {
    token: tokens.staff,
    method: 'PATCH',
    body: { status: 'checked_in' }
  });
  assert.equal(checkedIn.response.status, 200);
  const intake = await api('/api/consultations', {
    token: tokens.staff,
    method: 'POST',
    body: {
      appointment_id: booking.data.id,
      symptoms: `Test symptoms for ${reason}`,
      clinical_notes: 'Automated isolated test fixture.'
    }
  });
  assert.equal(intake.response.status, 201);
  return { appointmentId: booking.data.id, consultationId: intake.data.id };
}

test.before(async () => {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const env = {
    ...process.env,
    DB_FILE: testDatabase,
    UPLOAD_DIR: uploadRoot,
    EXPORT_DIR: exportRoot,
    JWT_SECRET: 'isolated-system-test-secret-at-least-32-chars',
    NODE_ENV: 'test'
  };
  execFileSync(process.execPath, ['src/setup.js'], { cwd: serverRoot, env, stdio: 'pipe' });
  execFileSync(process.execPath, ['src/seed.js'], { cwd: serverRoot, env, stdio: 'pipe' });
  port = await freePort();
  const smsPort = await freePort();
  env.PORT = String(port);
  env.SMS_GATEWAY_PORT = String(smsPort);
  env.SMS_GATEWAY_URL = `http://127.0.0.1:${smsPort}/sms`;
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['src/index.js'], { cwd: serverRoot, env, stdio: 'ignore' });
  child.on('error', error => {
    throw error;
  });

  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Test server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 125));
  }
  assert.equal(ready, true, 'isolated API server became ready');
});

test.after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  const resolvedTemp = path.resolve(tempRoot);
  if (
    path.dirname(resolvedTemp) === path.resolve(os.tmpdir()) &&
    path.basename(resolvedTemp).startsWith('carelink-system-test-')
  ) {
    fs.rmSync(resolvedTemp, { recursive: true, force: true });
  }
});

test('FT-01 Functional: health endpoint and all browser pages are served with the shared styles', async () => {
  const health = await api('/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.data.ok, true);
  const pages = fs.readdirSync(publicRoot).filter(name => name.endsWith('.html'));
  assert.ok(pages.length >= 12, `expected at least 12 screens, found ${pages.length}`);
  for (const page of pages) {
    const html = fs.readFileSync(path.join(publicRoot, page), 'utf8');
    assert.match(html, /assets\/(app|display)\.css/, `${page} loads a stylesheet`);
  }
  const usersPage = await api('/users.html');
  assert.equal(usersPage.response.status, 200);
  assert.match(usersPage.data, /User management/);
});

test('IT-01 Integration: all four seeded roles authenticate through the API and SQLite', async () => {
  for (const [username, role, key] of [
    ['admin', 'Admin', 'admin'],
    ['doctor1', 'Doctor', 'doctor'],
    ['doctor2', 'Doctor', 'doctor2'],
    ['clinic1', 'Clinic Staff', 'staff'],
    ['patient1', 'Patient', 'patient']
  ]) {
    const result = await api('/api/auth/login', { method: 'POST', body: { username, password: 'SysInt2026!', role } });
    assert.equal(result.response.status, 200);
    assert.equal(result.data.user.role, role);
    tokens[key] = result.data.token;
    if (key === 'doctor') tokens.doctorId = result.data.user.id;
  }
  const directory = await api('/api/patients', { token: tokens.admin });
  assert.equal(directory.response.status, 200);
  patients = directory.data;
  assert.ok(patients.length >= 3);
});

test('FT-02 Functional: signed-in staff can retrieve the active doctor directory', async () => {
  const doctors = await api('/api/doctors', { token: tokens.staff });
  assert.equal(doctors.response.status, 200);
  assert.ok(doctors.data.some(doctor => doctor.display_name === 'Dr. Taylor Cruz'));
});

test('FT-03 Functional: public AlagaQ registration creates a queue ticket without an account', async () => {
  const registration = await api('/api/public/tickets', {
    method: 'POST',
    body: {
      full_name: 'Public Queue Test',
      phone: '+639179990001',
      service: 'Checkup'
    }
  });
  assert.equal(registration.response.status, 201);
  assert.match(registration.data.ticket, /^A\d{3}$/);
  assert.ok(registration.data.position >= 1);
});

test('FT-04 Functional: dashboard metrics are returned for an authenticated role', async () => {
  const result = await api('/api/dashboard', { token: tokens.admin });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.api, 'online');
  assert.equal(result.data.database, 'connected');
  assert.ok(Number.isInteger(result.data.appointment_count));
});

test('FT-05 Functional: patient booking ignores another patient ID and allocates a queue number', async () => {
  const ownPatient = patients.find(person => person.mrn === 'MRN-10001');
  const otherPatient = patients.find(person => person.mrn === 'MRN-10002');
  const result = await api('/api/appointments', {
    token: tokens.patient,
    method: 'POST',
    body: {
      patient_id: otherPatient.id,
      scheduled_at: localDateTime(),
      reason: 'Patient self-booked visit'
    }
  });
  assert.equal(result.response.status, 201);
  appointmentId = result.data.id;
  assert.ok(Number.isInteger(result.data.queue_number));
  const ownAppointments = await api('/api/appointments', { token: tokens.patient });
  assert.ok(ownAppointments.data.some(row => row.id === appointmentId && row.patient_id === ownPatient.id));
  assert.ok(ownAppointments.data.every(row => row.patient_id === ownPatient.id));
});

test('IT-02 Integration: check-in updates appointment, queue and public display', async () => {
  const changed = await api(`/api/appointments/${appointmentId}/status`, {
    token: tokens.staff,
    method: 'PATCH',
    body: { status: 'checked_in' }
  });
  assert.equal(changed.response.status, 200);
  assert.equal(changed.data.status, 'checked_in');
  const queue = await api('/api/queue/control', { token: tokens.staff });
  assert.ok(queue.data.waiting.some(item => item.id === appointmentId));
  const display = await api('/api/public/queue-display');
  assert.ok(display.data.waiting.some(item => item.queue_number > 0));
});

test('FT-06 Functional: clinic intake can be submitted once and appears in consultation records', async () => {
  const created = await api('/api/consultations', {
    token: tokens.staff,
    method: 'POST',
    body: {
      appointment_id: appointmentId,
      symptoms: 'Recurring headache and nausea',
      clinical_notes: 'No reported allergies.'
    }
  });
  assert.equal(created.response.status, 201);
  consultationId = created.data.id;
  assert.equal(created.data.status, 'submitted');
  const rows = await api('/api/consultations?status=submitted', { token: tokens.doctor });
  assert.ok(rows.data.some(row => row.id === consultationId));
});

test('IT-03 Integration: doctor approval calls local SMS and records notification plus audit events', async () => {
  const approved = await api(`/api/consultations/${consultationId}/review`, {
    token: tokens.doctor,
    method: 'POST',
    body: {
      decision: 'approved',
      comment: 'Reviewed; patient follow-up guidance recorded.'
    }
  });
  assert.equal(approved.response.status, 200);
  assert.equal(approved.data.sms, 'sent');
  const notifications = await api('/api/notifications', { token: tokens.admin });
  assert.ok(notifications.data.some(row => row.event_type === 'consultation_approved' && row.status === 'sent'));
  const audit = await api('/api/audit', { token: tokens.admin });
  assert.ok(audit.data.some(row => row.action === 'consultation_approved' && row.entity_id === String(consultationId)));
  assert.ok(audit.data.some(row => row.action === 'sms_triggered'));
});

test('IT-04 Integration: asset upload persists file and two versions in SQLite', async () => {
  const patient = patients.find(person => person.mrn === 'MRN-10001');
  const filesBefore = fs.readdirSync(uploadRoot).length;
  const first = await uploadFile(patient.id, { filename: 'lab-report.pdf' });
  assert.equal(first.response.status, 201);
  assetId = first.data.asset_id;
  assert.equal(first.data.version_number, 1);
  assert.equal(fs.readdirSync(uploadRoot).length, filesBefore + 1);
  const revised = await uploadFile(patient.id, { asset: assetId, filename: 'lab-report-revised.pdf' });
  assert.equal(revised.response.status, 201);
  assert.equal(revised.data.version_number, 2);
  assert.equal(revised.data.status, 'revised');
  const history = await api('/api/assets', { token: tokens.staff });
  assert.ok(history.data.some(row => row.asset_id === assetId && row.version_number === 1));
  assert.ok(history.data.some(row => row.asset_id === assetId && row.version_number === 2));
});

test('FT-07 Functional: linked patient can download their own stored file version', async () => {
  const download = await api(`/api/assets/${assetId}/download/1`, { token: tokens.patient });
  assert.equal(download.response.status, 200);
  assert.match(download.data, /%PDF-1\.4 CareLink test fixture/);
});

test('FT-08 Functional: doctor can approve the current asset version with a comment and trigger the SMS mock', async () => {
  const approved = await api(`/api/assets/${assetId}/approve`, {
    token: tokens.doctor,
    method: 'POST',
    body: { comment: 'Version reviewed and approved.' }
  });
  assert.equal(approved.response.status, 200);
  assert.equal(approved.data.status, 'approved');
  assert.equal(approved.data.sms, 'sent');
});

test('FT-09 Functional: doctor rejection records a comment and does not trigger an approval SMS', async () => {
  const patient = patients.find(person => person.mrn === 'MRN-10002');
  const fixture = await makeConsultation(patient.id, 'Rejection-path check');
  const rejected = await api(`/api/consultations/${fixture.consultationId}/review`, {
    token: tokens.doctor,
    method: 'POST',
    body: {
      decision: 'rejected',
      comment: 'Please clarify the intake record before approval.'
    }
  });
  assert.equal(rejected.response.status, 200);
  assert.equal(rejected.data.status, 'rejected');
  assert.equal(rejected.data.sms, null);
  const rows = await api('/api/consultations', { token: tokens.doctor });
  assert.equal(
    rows.data.find(row => row.id === fixture.consultationId).doctor_comment,
    'Please clarify the intake record before approval.'
  );
});

test('FT-10 Functional: doctor can reject a current file version with a comment and no SMS', async () => {
  const patient = patients.find(person => person.mrn === 'MRN-10003');
  const uploaded = await uploadFile(patient.id, { filename: 'needs-correction.pdf' });
  assert.equal(uploaded.response.status, 201);
  const rejected = await api(`/api/assets/${uploaded.data.asset_id}/review`, {
    token: tokens.doctor,
    method: 'POST',
    body: {
      decision: 'rejected',
      comment: 'Please submit a readable copy.'
    }
  });
  assert.equal(rejected.response.status, 200);
  assert.equal(rejected.data.status, 'rejected');
  assert.equal(rejected.data.sms, null);
  const history = await api('/api/assets', { token: tokens.doctor });
  const version = history.data.find(row => row.asset_id === uploaded.data.asset_id);
  assert.equal(version.status, 'rejected');
  assert.equal(version.comment, 'Please submit a readable copy.');
});

test('IT-05 Integration: PhilHealth export contains approved data and is downloadable', async () => {
  const result = await api('/api/integrations/philhealth/export', { token: tokens.admin, method: 'POST', body: {} });
  assert.equal(result.response.status, 201);
  assert.ok(result.data.records >= 1);
  assert.ok(fs.existsSync(path.join(exportRoot, result.data.filename)));
  assert.ok(fs.existsSync(path.join(exportRoot, 'latest.csv')));
  const latest = await api('/api/integrations/philhealth/latest', { token: tokens.admin });
  assert.equal(latest.response.status, 200);
  assert.match(latest.data, /"consultation_id","patient_mrn"/);
  assert.match(latest.data, /MRN-10001/);
});

test('EH-01 Error handling: missing bearer token is rejected', async () => {
  const result = await api('/api/users');
  assert.equal(result.response.status, 401);
});

test('EH-02 Error handling: invalid login role or credentials are rejected', async () => {
  const result = await api('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'bad', role: 'Admin' }
  });
  assert.equal(result.response.status, 401);
  const invalidRole = await api('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'SysInt2026!', role: 'Nurse' }
  });
  assert.equal(invalidRole.response.status, 400);
});

test('EH-03 Error handling: appointment validation and illegal state transition return client errors', async () => {
  const invalidBooking = await api('/api/appointments', {
    token: tokens.patient,
    method: 'POST',
    body: { reason: 'Missing time' }
  });
  assert.equal(invalidBooking.response.status, 400);
  const invalidTransition = await api(`/api/appointments/${appointmentId}/status`, {
    token: tokens.staff,
    method: 'PATCH',
    body: { status: 'completed' }
  });
  assert.equal(invalidTransition.response.status, 409);
});

test('EH-04 Error handling: duplicate intake is rejected', async () => {
  const duplicate = await api('/api/consultations', {
    token: tokens.staff,
    method: 'POST',
    body: {
      appointment_id: appointmentId,
      symptoms: 'Duplicate record'
    }
  });
  assert.equal(duplicate.response.status, 409);
});

test('EH-05 Error handling: review requires an existing pending record, valid decision and comment', async () => {
  const unknown = await api('/api/consultations/999999/review', {
    token: tokens.doctor,
    method: 'POST',
    body: { decision: 'approved', comment: 'Test' }
  });
  assert.equal(unknown.response.status, 404);
  const pending = await makeConsultation(patients.find(person => person.mrn === 'MRN-10002').id, 'Validation fixture');
  const missingComment = await api(`/api/consultations/${pending.consultationId}/review`, {
    token: tokens.doctor,
    method: 'POST',
    body: { decision: 'approved', comment: ' ' }
  });
  assert.equal(missingComment.response.status, 400);
  const invalidDecision = await api(`/api/consultations/${pending.consultationId}/review`, {
    token: tokens.doctor,
    method: 'POST',
    body: { decision: 'deferred', comment: 'Needs follow-up.' }
  });
  assert.equal(invalidDecision.response.status, 400);
  const patient = patients.find(person => person.mrn === 'MRN-10003');
  const pendingAsset = await uploadFile(patient.id, { filename: 'asset-review-validation.pdf' });
  const missingAssetComment = await api(`/api/assets/${pendingAsset.data.asset_id}/approve`, {
    token: tokens.doctor,
    method: 'POST',
    body: {}
  });
  assert.equal(missingAssetComment.response.status, 400);
});

test('EH-06 Error handling: upload rejects unsupported file extensions', async () => {
  const form = new FormData();
  form.append('patient_id', String(patients[0].id));
  form.append('file', new Blob(['not a supported document']), 'payload.exe');
  const result = await api('/api/assets', { token: tokens.staff, method: 'POST', body: form });
  assert.equal(result.response.status, 400);
});

test('SC-01 Security: patient and doctor roles cannot access admin-only resources', async () => {
  const audit = await api('/api/audit', { token: tokens.patient });
  const users = await api('/api/users', { token: tokens.patient });
  const doctorUsers = await api('/api/users', { token: tokens.doctor });
  assert.equal(audit.response.status, 403);
  assert.equal(users.response.status, 403);
  assert.equal(doctorUsers.response.status, 403);
});

test('SC-02 Security: patient cannot submit a clinic intake or create another user role', async () => {
  const intake = await api('/api/consultations', {
    token: tokens.patient,
    method: 'POST',
    body: { appointment_id: appointmentId, symptoms: 'Unauthorized' }
  });
  const createUser = await api('/api/users', {
    token: tokens.patient,
    method: 'POST',
    body: { username: 'blocked-user', password: 'long-password', role: 'Doctor', display_name: 'Blocked' }
  });
  assert.equal(intake.response.status, 403);
  assert.equal(createUser.response.status, 403);
});

test('SC-03 Security: patient download is restricted to their linked patient record', async () => {
  const otherPatient = patients.find(person => person.mrn === 'MRN-10002');
  const uploaded = await uploadFile(otherPatient.id, { filename: 'other-patient.pdf' });
  assert.equal(uploaded.response.status, 201);
  const denied = await api(`/api/assets/${uploaded.data.asset_id}/download/1`, { token: tokens.patient });
  assert.equal(denied.response.status, 403);
});

test('SC-04 Security: audit rows reject updates and deletes at the SQLite schema layer', () => {
  const db = new Database(testDatabase);
  assert.throws(
    () => db.prepare('DELETE FROM audit_logs WHERE id=(SELECT MAX(id) FROM audit_logs)').run(),
    /immutable/
  );
  assert.throws(
    () => db.prepare("UPDATE audit_logs SET action='tampered' WHERE id=(SELECT MAX(id) FROM audit_logs)").run(),
    /immutable/
  );
  db.close();
});

test('E2E-01 End-to-end: booking, check-in, intake, revision, resubmission, approval, SMS/email and ETL export', async () => {
  const patient = patients.find(person => person.mrn === 'MRN-10003');
  const booking = await api('/api/appointments', {
    token: tokens.staff,
    method: 'POST',
    body: {
      patient_id: patient.id,
      scheduled_at: localDateTime(),
      reason: 'End-to-end follow-up',
      doctor_id: tokens.doctorId
    }
  });
  assert.equal(booking.response.status, 201);
  const checkIn = await api(`/api/appointments/${booking.data.id}/status`, {
    token: tokens.staff,
    method: 'PATCH',
    body: { status: 'checked_in' }
  });
  assert.equal(checkIn.data.status, 'checked_in');
  const intake = await api('/api/consultations', {
    token: tokens.staff,
    method: 'POST',
    body: { appointment_id: booking.data.id, symptoms: 'Cough for one week.', clinical_notes: 'No vitals yet.' }
  });
  assert.equal(intake.response.status, 201);
  const reviewUrl = `/api/consultations/${intake.data.id}/review`;
  const revision = await api(reviewUrl, {
    token: tokens.doctor,
    method: 'POST',
    body: { decision: 'revision_requested', comment: 'Please add temperature.' }
  });
  assert.equal(revision.data.status, 'revision_requested');
  const resubmitted = await api(`/api/consultations/${intake.data.id}`, {
    token: tokens.staff,
    method: 'PUT',
    body: { symptoms: 'Cough for one week.', clinical_notes: 'Temp 37.4 C.', revision_note: 'Temperature added.' }
  });
  assert.equal(resubmitted.data.revision, 2);
  const decision = await api(reviewUrl, {
    token: tokens.doctor,
    method: 'POST',
    body: { decision: 'approved', comment: 'End-to-end test review completed.' }
  });
  assert.equal(decision.response.status, 200);
  assert.equal(decision.data.sms, 'sent');
  assert.equal(decision.data.email, 'sent');
  const exportResult = await api('/api/integrations/philhealth/export', {
    token: tokens.admin,
    method: 'POST',
    body: {}
  });
  assert.equal(exportResult.response.status, 201);
  const rows = await api('/api/notifications', { token: tokens.admin });
  assert.ok(
    rows.data.some(
      row => row.event_type === 'consultation_approved' && row.patient_id === patient.id && row.status === 'sent'
    )
  );
  const audit = await api('/api/audit', { token: tokens.admin });
  const actions = audit.data.filter(row => row.entity_id === String(intake.data.id)).map(row => row.action);
  for (const action of [
    'consultation_submitted',
    'consultation_revision_requested',
    'consultation_resubmitted',
    'consultation_approved'
  ]) {
    assert.ok(actions.includes(action), `audit contains ${action}`);
  }
  assert.ok(fs.readFileSync(path.join(exportRoot, 'latest.csv'), 'utf8').includes('Temp 37.4 C.'));
});

async function waitFor(check, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
}

test('FT-11 Functional: doctor can request a revision and staff resubmit the consultation as a new revision', async () => {
  const fixture = await makeConsultation(patients.find(person => person.mrn === 'MRN-10002').id, 'Revision workflow');
  const requested = await api(`/api/consultations/${fixture.consultationId}/review`, {
    token: tokens.doctor,
    method: 'POST',
    body: { decision: 'revision_requested', comment: 'Add blood pressure reading.' }
  });
  assert.equal(requested.response.status, 200);
  assert.equal(requested.data.status, 'revision_requested');
  assert.equal(requested.data.sms, null);
  const resubmitted = await api(`/api/consultations/${fixture.consultationId}`, {
    token: tokens.staff,
    method: 'PUT',
    body: {
      symptoms: 'Dizziness when standing. BP 110/70.',
      clinical_notes: 'Vitals captured.',
      revision_note: 'BP added as requested.'
    }
  });
  assert.equal(resubmitted.response.status, 200);
  assert.equal(resubmitted.data.status, 'submitted');
  assert.equal(resubmitted.data.revision, 2);
  const thread = await api(`/api/comments?entity_type=consultation&entity_id=${fixture.consultationId}`, {
    token: tokens.staff
  });
  assert.deepEqual(
    thread.data.comments.map(row => row.kind),
    ['review', 'revision_note']
  );
});

test('FT-12 Functional: a file revision request is answered by uploading the next version', async () => {
  const patient = patients.find(person => person.mrn === 'MRN-10001');
  const uploaded = await uploadFile(patient.id, { filename: 'blurry-prescription.pdf' });
  const requested = await api(`/api/assets/${uploaded.data.asset_id}/review`, {
    token: tokens.doctor,
    method: 'POST',
    body: { decision: 'revision_requested', comment: 'Scan is blurry; please upload a clearer copy.' }
  });
  assert.equal(requested.response.status, 200);
  assert.equal(requested.data.status, 'revision_requested');
  const revised = await uploadFile(patient.id, { asset: uploaded.data.asset_id, filename: 'clear-prescription.pdf' });
  assert.equal(revised.data.version_number, 2);
  assert.equal(revised.data.status, 'revised');
  const approved = await api(`/api/assets/${uploaded.data.asset_id}/review`, {
    token: tokens.doctor,
    method: 'POST',
    body: { decision: 'approved', comment: 'Readable now.' }
  });
  assert.equal(approved.data.status, 'approved');
  assert.equal(approved.data.version_number, 2);
});

test('FT-13 Functional: users can add comments to records they can access and read the thread', async () => {
  const added = await api('/api/comments', {
    token: tokens.patient,
    method: 'POST',
    body: { entity_type: 'asset', entity_id: assetId, body: 'Thank you, I received the result.' }
  });
  assert.equal(added.response.status, 201);
  const thread = await api(`/api/comments?entity_type=asset&entity_id=${assetId}`, { token: tokens.staff });
  assert.ok(
    thread.data.comments.some(row => row.body === 'Thank you, I received the result.' && row.author_role === 'Patient')
  );
  const ownPatientId = patients.find(person => person.mrn === 'MRN-10001').id;
  const recent = await api('/api/comments', { token: tokens.patient });
  assert.ok(recent.data.comments.every(row => row.patient_id === ownPatientId));
});

test('FT-14 Functional: visit details aggregate appointment, consultation, comments, files and queue history', async () => {
  const details = await api(`/api/appointments/${appointmentId}`, { token: tokens.admin });
  assert.equal(details.response.status, 200);
  assert.equal(details.data.appointment.id, appointmentId);
  assert.equal(details.data.consultation.id, consultationId);
  assert.ok(details.data.comments.some(row => row.kind === 'review'));
  assert.ok(details.data.files.length >= 1);
  assert.ok(details.data.queue_events.some(row => row.event_type === 'manual_queue_check_in'));
  assert.ok(Array.isArray(details.data.audit));
});

test('FT-15 Functional: reports summarise workflow, notification and integration status for staff roles', async () => {
  const report = await api('/api/reports', { token: tokens.staff });
  assert.equal(report.response.status, 200);
  const sections = [
    'appointments_by_status',
    'consultations_by_status',
    'files_by_status',
    'doctor_workload',
    'notifications_by_channel',
    'integrations_by_status',
    'overdue_reviews',
    'missed_appointments'
  ];
  for (const key of sections) assert.ok(Array.isArray(report.data[key]), `${key} is present`);
  assert.ok(report.data.consultations_by_status.some(row => row.status === 'approved'));
  const badRange = await api('/api/reports?from=2026-12-31&to=2026-01-01', { token: tokens.admin });
  assert.equal(badRange.response.status, 400);
});

test('IT-06 Integration: approval event fans out to SMS and email under one traceable transaction ID', async () => {
  const fixture = await makeConsultation(patients.find(person => person.mrn === 'MRN-10001').id, 'Transaction trace');
  const approved = await api(`/api/consultations/${fixture.consultationId}/review`, {
    token: tokens.doctor,
    method: 'POST',
    body: { decision: 'approved', comment: 'Approved for trace test.' }
  });
  assert.equal(approved.data.sms, 'sent');
  assert.equal(approved.data.email, 'sent');
  const logs = await api(`/api/integrations/logs?transaction_id=${approved.data.transaction_id}`, {
    token: tokens.admin
  });
  assert.deepEqual(logs.data.map(row => row.integration).sort(), ['email_gateway', 'event_bus', 'sms_gateway']);
  assert.ok(logs.data.every(row => row.status === 'success'));
});

test('IT-07 Integration: new submissions and revision requests reach the doctor and staff in-app inboxes', async () => {
  const doctorInbox = await api('/api/notifications', { token: tokens.doctor });
  assert.equal(doctorInbox.response.status, 200);
  assert.ok(doctorInbox.data.some(row => row.event_type === 'consultation_submitted' && row.channel === 'in_app'));
  assert.ok(doctorInbox.data.every(row => row.recipient_role === 'Doctor'));
  const staffInbox = await api('/api/notifications', { token: tokens.staff });
  assert.ok(staffInbox.data.some(row => row.event_type === 'consultation_revision_requested'));
  const patientInbox = await api('/api/notifications', { token: tokens.patient });
  assert.ok(patientInbox.data.every(row => row.recipient_role === null || row.recipient_role === 'Patient'));
});

test('IT-08 Integration: CSV import cleans and loads valid appointments, skips duplicates and logs rejected rows', async () => {
  const csv = fs.readFileSync(path.join(serverRoot, 'samples', 'appointments-import.csv'), 'utf8');
  const result = await api('/api/integrations/appointments/import', {
    token: tokens.staff,
    method: 'POST',
    body: { filename: 'appointments-import.csv', csv }
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.data.status, 'partial');
  assert.deepEqual([result.data.imported, result.data.skipped, result.data.failed], [3, 1, 3]);
  const directory = await api('/api/patients', { token: tokens.admin });
  const dana = directory.data.find(person => person.mrn === 'MRN-20001');
  assert.equal(dana.full_name, 'Dana Cruz');
  assert.equal(dana.phone, '+639172220001');
  assert.equal(dana.email, 'dana@example.test');
  const logs = await api(`/api/integrations/logs?transaction_id=${result.data.transaction_id}`, {
    token: tokens.admin
  });
  assert.equal(logs.data.filter(row => row.action === 'row_rejected' && row.status === 'failed').length, 3);
  assert.ok(logs.data.some(row => row.action === 'appointments_import' && row.status === 'partial'));
  const again = await api('/api/integrations/appointments/import', {
    token: tokens.staff,
    method: 'POST',
    body: { csv }
  });
  assert.equal(again.data.imported, 0);
  assert.equal(again.data.skipped, 4);
});

test('IT-09 Integration: calling the next queue ticket sends the patient a queue SMS', async () => {
  const called = await api('/api/queue/control/next', { token: tokens.staff, method: 'POST', body: {} });
  assert.equal(called.response.status, 200);
  assert.match(called.data.current, /^A\d{3}$/);
  const found = await waitFor(async () => {
    const rows = await api('/api/notifications', { token: tokens.admin });
    return rows.data.find(row => row.event_type === 'queue_patient_called' && row.channel === 'sms');
  });
  assert.ok(found, 'queue call SMS was logged');
  assert.equal(found.status, 'sent');
});

test('EH-07 Error handling: a missing patient phone is logged as a failed SMS without undoing the approval', async () => {
  const fixture = await makeConsultation(patients.find(person => person.mrn === 'MRN-10005').id, 'No phone on file');
  const approved = await api(`/api/consultations/${fixture.consultationId}/review`, {
    token: tokens.doctor,
    method: 'POST',
    body: { decision: 'approved', comment: 'Approved; patient has no phone.' }
  });
  assert.equal(approved.response.status, 200);
  assert.equal(approved.data.status, 'approved');
  assert.equal(approved.data.sms, 'failed');
  const logs = await api(`/api/integrations/logs?transaction_id=${approved.data.transaction_id}`, {
    token: tokens.admin
  });
  assert.ok(
    logs.data.some(
      row => row.integration === 'sms_gateway' && row.status === 'failed' && /phone number/.test(row.error_message)
    )
  );
  const records = await api('/api/consultations?status=approved', { token: tokens.admin });
  assert.ok(records.data.some(row => row.id === fixture.consultationId));
});

test('EH-08 Error handling: CSV import rejects a missing header column and records the failure', async () => {
  const result = await api('/api/integrations/appointments/import', {
    token: tokens.admin,
    method: 'POST',
    body: { filename: 'bad-header.csv', csv: 'name,when\nA,B\n' }
  });
  assert.equal(result.response.status, 400);
  assert.match(result.data.error, /full_name, scheduled_at, reason/);
  const logs = await api(`/api/integrations/logs?transaction_id=${result.data.transaction_id}`, {
    token: tokens.admin
  });
  assert.equal(logs.data[0].status, 'failed');
});

test('EH-09 Error handling: resubmission and comments validate state and input', async () => {
  const notRevisable = await api(`/api/consultations/${consultationId}`, {
    token: tokens.staff,
    method: 'PUT',
    body: { symptoms: 'x' }
  });
  assert.equal(notRevisable.response.status, 409);
  const emptyComment = await api('/api/comments', {
    token: tokens.staff,
    method: 'POST',
    body: { entity_type: 'asset', entity_id: assetId, body: ' ' }
  });
  assert.equal(emptyComment.response.status, 400);
  const unknownRecord = await api('/api/comments', {
    token: tokens.staff,
    method: 'POST',
    body: { entity_type: 'asset', entity_id: 999999, body: 'Hello' }
  });
  assert.equal(unknownRecord.response.status, 404);
});

test('SC-05 Security: a doctor cannot review a consultation assigned to another doctor', async () => {
  const submitted = await api('/api/consultations?status=submitted', { token: tokens.doctor });
  const assigned = submitted.data.find(row => row.doctor_id !== null);
  assert.ok(assigned, 'a submitted consultation assigned to doctor1 exists');
  const denied = await api(`/api/consultations/${assigned.id}/review`, {
    token: tokens.doctor2,
    method: 'POST',
    body: { decision: 'approved', comment: 'Not my patient.' }
  });
  assert.equal(denied.response.status, 403);
  const doctor2List = await api('/api/consultations', { token: tokens.doctor2 });
  assert.ok(doctor2List.data.every(row => row.id !== assigned.id));
});

test("SC-06 Security: patients cannot read another patient's visit, comments or reports", async () => {
  const other = await makeConsultation(patients.find(person => person.mrn === 'MRN-10002').id, 'Privacy check');
  const results = await Promise.all([
    api(`/api/appointments/${other.appointmentId}`, { token: tokens.patient }),
    api(`/api/comments?entity_type=consultation&entity_id=${other.consultationId}`, { token: tokens.patient }),
    api('/api/comments', {
      token: tokens.patient,
      method: 'POST',
      body: { entity_type: 'consultation', entity_id: other.consultationId, body: 'Hi' }
    }),
    api('/api/reports', { token: tokens.patient }),
    api('/api/integrations/logs', { token: tokens.staff })
  ]);
  assert.deepEqual(
    results.map(result => result.response.status),
    [403, 403, 403, 403, 403]
  );
});

test('SC-07 Security: deactivating an account blocks its existing session and new sign-ins', async () => {
  const credentials = { username: 'temp-staff', password: 'temporary-pass', role: 'Clinic Staff' };
  const created = await api('/api/users', {
    token: tokens.admin,
    method: 'POST',
    body: { ...credentials, display_name: 'Temporary Staff' }
  });
  assert.equal(created.response.status, 201);
  const login = await api('/api/auth/login', { method: 'POST', body: credentials });
  assert.equal(login.response.status, 200);
  const deactivated = await api(`/api/users/${created.data.id}/status`, {
    token: tokens.admin,
    method: 'PATCH',
    body: { active: false }
  });
  assert.equal(deactivated.response.status, 200);
  const session = await api('/api/dashboard', { token: login.data.token });
  assert.equal(session.response.status, 401);
  const relogin = await api('/api/auth/login', { method: 'POST', body: credentials });
  assert.equal(relogin.response.status, 401);
});

test('BR-01 Backup: create makes an integrity-checked SQLite snapshot with uploads and exports', () => {
  const env = { ...process.env, DB_FILE: testDatabase, UPLOAD_DIR: uploadRoot, EXPORT_DIR: exportRoot };
  execFileSync(process.execPath, ['src/backup.js', 'create', backupRoot], { cwd: serverRoot, env, stdio: 'pipe' });
  const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.integrity_check, 'ok');
  assert.ok(fs.existsSync(path.join(backupRoot, 'healthcare.sqlite')));
  assert.ok(fs.existsSync(path.join(backupRoot, 'uploads')));
  assert.ok(fs.existsSync(path.join(backupRoot, 'exports', 'philhealth', 'latest.csv')));
});

test('BR-02 Backup: restore recovers SQLite records and runtime files to isolated target folders', () => {
  const restoredDatabase = path.join(runtimeRoot, 'restore-target.sqlite');
  const restoredUploads = path.join(runtimeRoot, 'restore-uploads');
  const restoredExports = path.join(runtimeRoot, 'restore-exports');
  fs.mkdirSync(restoredUploads, { recursive: true });
  fs.mkdirSync(restoredExports, { recursive: true });
  fs.writeFileSync(path.join(restoredUploads, 'stale-untracked-file.txt'), 'should be replaced by the snapshot');
  fs.writeFileSync(path.join(restoredExports, 'stale-export.csv'), 'should be replaced by the snapshot');
  const env = { ...process.env, DB_FILE: restoredDatabase, UPLOAD_DIR: restoredUploads, EXPORT_DIR: restoredExports };
  execFileSync(process.execPath, ['src/backup.js', 'restore', backupRoot], { cwd: serverRoot, env, stdio: 'pipe' });
  const restored = new Database(restoredDatabase, { readonly: true });
  assert.ok(restored.prepare('SELECT COUNT(*) AS count FROM patients').get().count >= 3);
  assert.ok(restored.prepare("SELECT COUNT(*) AS count FROM consultations WHERE status='approved'").get().count >= 1);
  restored.close();
  assert.ok(fs.readdirSync(restoredUploads).length >= 2);
  assert.equal(fs.existsSync(path.join(restoredUploads, 'stale-untracked-file.txt')), false);
  assert.equal(fs.existsSync(path.join(restoredExports, 'stale-export.csv')), false);
  assert.ok(fs.existsSync(path.join(restoredExports, 'latest.csv')));
});
