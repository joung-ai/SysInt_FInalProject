require('./setup');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { clinicDateString } = require('./lib/clinic');

const PASSWORD = 'SysInt2026!';
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));

async function seed() {
  const patientData = [
    ['MRN-10001', 'Jamie Santos', '1988-04-12', '+639171110001', 'jamie@example.test'],
    ['MRN-10002', 'Alex Rivera', '1975-11-03', '+639171110002', 'alex@example.test'],
    ['MRN-10003', 'Morgan Lee', '1993-07-24', '+639171110003', 'morgan@example.test'],
    ['MRN-10004', 'Riley Bautista', '2001-02-17', '+639171110004', 'riley@example.test'],
    ['MRN-10005', 'Sam Villanueva', '1969-09-30', null, null]
  ];
  const addPatient = db.prepare(
    'INSERT OR IGNORE INTO patients(mrn, full_name, date_of_birth, phone, email) VALUES(?, ?, ?, ?, ?)'
  );
  const getPatient = db.prepare('SELECT id, full_name FROM patients WHERE mrn = ?');
  for (const patient of patientData) addPatient.run(...patient);
  const patients = patientData.map(row => getPatient.get(row[0]));

  const accounts = [
    { username: 'admin', role: 'Admin', name: 'System Administrator' },
    { username: 'doctor1', role: 'Doctor', name: 'Dr. Taylor Cruz' },
    { username: 'doctor2', role: 'Doctor', name: 'Dr. Robin Mendoza' },
    { username: 'clinic1', role: 'Clinic Staff', name: 'Casey Clinic Staff' },
    { username: 'patient1', role: 'Patient', name: patients[0].full_name, patientId: patients[0].id }
  ];
  const findUser = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE');
  const addUser = db.prepare(
    'INSERT INTO users(username, password_hash, role, display_name, patient_id) VALUES(?, ?, ?, ?, ?)'
  );
  const users = {};
  for (const account of accounts) {
    let existing = findUser.get(account.username);
    if (!existing) {
      const hash = await bcrypt.hash(PASSWORD, 10);
      existing = {
        id: addUser.run(account.username, hash, account.role, account.name, account.patientId || null).lastInsertRowid
      };
    }
    users[account.username] = Number(existing.id);
  }

  // Today's visits: [patient index, doctor, time, status]. Queue numbers follow the list order.
  const today = clinicDateString();
  const visits = [
    [0, users.doctor1, '09:00', 'checked_in'],
    [1, users.doctor1, '09:30', 'checked_in'],
    [2, users.doctor1, '10:00', 'checked_in'],
    [3, users.doctor2, '10:30', 'checked_in'],
    [4, null, '15:00', 'booked']
  ];
  const findVisit = db.prepare(
    "SELECT id FROM appointments WHERE patient_id = ? AND reason = 'Demo follow-up' AND date(scheduled_at) = date(?)"
  );
  const nextQueue = db.prepare(
    'SELECT COALESCE(MAX(queue_number), 0) + 1 AS n FROM appointments WHERE date(scheduled_at) = date(?)'
  );
  const addVisit = db.prepare(
    `INSERT INTO appointments(patient_id, doctor_id, scheduled_at, queue_number, queue_order, reason, status, created_by)
     VALUES(?, ?, ?, ?, ?, 'Demo follow-up', ?, ?)`
  );
  const appointmentIds = visits.map(([index, doctorId, time, status]) => {
    const found = findVisit.get(patients[index].id, today);
    if (found) return found.id;
    const queue = nextQueue.get(today).n;
    return Number(
      addVisit.run(patients[index].id, doctorId, `${today}T${time}`, queue, queue, status, users.clinic1)
        .lastInsertRowid
    );
  });

  const hasConsultation = db.prepare('SELECT id FROM consultations WHERE appointment_id = ?');
  const addConsultation = db.prepare(
    `INSERT INTO consultations(appointment_id, patient_id, submitted_by, symptoms, clinical_notes, status, doctor_comment, reviewed_by, reviewed_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END)`
  );
  const addComment = db.prepare(
    `INSERT INTO comments(entity_type, entity_id, version_number, author_id, kind, decision, body)
     VALUES(?, ?, 1, ?, ?, ?, ?)`
  );
  if (!hasConsultation.get(appointmentIds[0])) {
    addConsultation.run(
      appointmentIds[0],
      patients[0].id,
      users.clinic1,
      'Recurring headache and mild nausea for two days.',
      'Intake completed at check-in; no known medication allergies reported.',
      'submitted',
      '',
      null,
      null
    );
  }
  if (!hasConsultation.get(appointmentIds[1])) {
    const comment = 'Please record blood pressure and current medications before I review.';
    const id = addConsultation.run(
      appointmentIds[1],
      patients[1].id,
      users.clinic1,
      'Dizziness when standing.',
      'Vitals not yet captured.',
      'revision_requested',
      comment,
      users.doctor1,
      users.doctor1
    ).lastInsertRowid;
    addComment.run('consultation', id, users.doctor1, 'review', 'revision_requested', comment);
    addComment.run(
      'consultation',
      id,
      users.clinic1,
      'comment',
      null,
      'Noted. Patient is in the waiting area; vitals will be taken next.'
    );
  }

  // One sample lab result so the file, version and review screens have data on first run.
  const hasAsset = db
    .prepare(
      "SELECT a.id FROM assets a JOIN asset_versions v ON v.asset_id = a.id WHERE v.storage_name = 'seed-cbc-lab-result.pdf'"
    )
    .get();
  if (!hasAsset) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const pdf = '%PDF-1.4\n% CareLink demo file: Complete blood count (fictional sample data)\n';
    fs.writeFileSync(path.join(UPLOAD_DIR, 'seed-cbc-lab-result.pdf'), pdf);
    const assetId = db
      .prepare("INSERT INTO assets(patient_id, uploaded_by, category) VALUES(?, ?, 'Lab result')")
      .run(patients[0].id, users.clinic1).lastInsertRowid;
    db.prepare(
      `INSERT INTO asset_versions(asset_id, version_number, original_name, storage_name, mime_type, size_bytes, status, uploaded_by)
       VALUES(?, 1, 'cbc-lab-result.pdf', 'seed-cbc-lab-result.pdf', 'application/pdf', ?, 'uploaded', ?)`
    ).run(assetId, Buffer.byteLength(pdf), users.clinic1);
  }

  if (!db.prepare("SELECT id FROM notification_logs WHERE event_type = 'seed_ready'").get()) {
    db.prepare(
      `INSERT INTO notification_logs(channel, event_type, message, status, response_body)
       VALUES('system', 'seed_ready', 'Demo records and role accounts are ready.', 'system', 'Seed script')`
    ).run();
  }

  console.log(`Demo data is ready. All demo accounts use the password: ${PASSWORD}`);
  console.log('Accounts: admin (Admin), doctor1 / doctor2 (Doctor), clinic1 (Clinic Staff), patient1 (Patient).');
  db.close();
}

seed().catch(error => {
  console.error(error);
  db.close();
  process.exitCode = 1;
});
