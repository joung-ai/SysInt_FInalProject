# CareLink / AlagaQ · Healthcare Integration System

An integrated clinic system for the Systems Integration and Architecture final project (Theme 4: Healthcare Appointment, Queue, and Patient Notification Integration). It connects public queue registration, appointment booking, the queue terminal, clinical intake, doctor review with revision requests, versioned patient files, comments, patient SMS/email notifications, CSV appointment import, PhilHealth CSV export, reports, and an immutable audit trail.

The browser UI is plain HTML, CSS, and JavaScript; the API uses Express and SQLite. Full documentation is in [`submission/final-report.md`](submission/final-report.md).

## Quick start

Requires Node.js 18.17 or newer. From the `server` directory:

```powershell
npm install
npm run setup   # creates/migrates server/data/healthcare.sqlite
npm run seed    # demo patients, visits, records, and accounts (safe to re-run)
npm start       # http://localhost:3000 and the SMS/email gateway mock on 127.0.0.1:5051
```

All demo accounts use the password `SysInt2026!`:

| Username | Role |
| --- | --- |
| `admin` | Admin |
| `doctor1`, `doctor2` | Doctor |
| `clinic1` | Clinic Staff |
| `patient1` | Patient (Jamie Santos) |

Public pages need no account: `register.html` (get a queue ticket on a phone) and `display.html` (live queue board).

`setup` is safe to re-run and migrates databases created by earlier versions. The built-in JWT secret is for local use only: set `NODE_ENV=production` and a long random `JWT_SECRET` before any real deployment, and never use real patient data.

## How it fits together

```text
Browser / phone ──REST + JWT──▶ Express API ──▶ SQLite, uploads/, exports/
                                    │
                         publish workflow events
                                    ▼
                              Event bus ──▶ in-app alerts (Doctor / Clinic Staff inboxes)
                                    └────▶ Notifier ──HTTP──▶ SMS / email gateway (mock)
Partner CSV ──▶ Import ETL ──▶ patients + appointments
Approved consultations ──▶ Export ETL ──▶ PhilHealth CSV
Every step ──▶ integration_logs (transaction ID) · notification_logs · audit_logs (immutable)
```

Main workflow:

1. A patient gets a ticket from `register.html`, books from the portal, or arrives through a CSV import.
2. Clinic Staff check the patient in and submit the intake record. Doctors are alerted in-app.
3. A Doctor approves, rejects, or **requests a revision** (comment required). Staff are alerted, correct the record, and resubmit it as the next revision.
4. Approval publishes an event; the notifier sends the patient an SMS and email through the gateway. Calling a ticket from the queue terminal sends an SMS. Failures are logged and never undo the decision.
5. Files are uploaded with a category; every upload to the same file ID creates a new version that the Doctor can approve, reject, or send back for revision.
6. Admin exports approved consultations to the PhilHealth CSV and traces any transaction on the Integrations page.

## Code layout

| Path | Contents |
| --- | --- |
| `public/*.html` | 16 pages — 14 portal pages (login, dashboard, reports, appointments, visit details, queue terminal, intake, files, doctor review, feedback, notifications, integrations, audit, users) plus public `register.html` and `display.html` |
| `public/assets/app.js` | Shared browser core: API client, helpers, role-based sidebar, page registry |
| `public/assets/pages/*.js` | One script per portal page |
| `public/assets/app.css` | Shared design system |
| `server/schema.sql` | Tables, constraints, indexes, audit-immutability triggers |
| `server/src/index.js` | Middleware, routers, event bus wiring, gateway mock |
| `server/src/routes/` | `accounts`, `appointments`, `queue`, `consultations`, `assets`, `comments`, `reports`, `integrations`, `system` |
| `server/src/services/` | `eventBus`, `notifier`, `workflowSubscribers` |
| `server/src/lib/` | `clinic` (dates, queue numbers), `access` (record-level rules), `csv` |
| `server/src/setup.js`, `seed.js`, `backup.js` | Schema + migrations, demo data, backup/restore |
| `server/samples/appointments-import.csv` | Sample file for the CSV import demo |
| `server/test/system.test.js` | 43 automated tests (IDs FT/IT/EH/SC/E2E/BR) |
| `submission/` | Final report, slide outline, test results, screenshots, evidence |

## Tests

From `server`:

```powershell
npm test
```

The suite creates and removes its own temporary database, folders, and ports; it never touches `server/data/healthcare.sqlite`. Current result: 43 passed, 0 failed.

## Backup and recovery

```powershell
node src/backup.js create                       # while running: consistent snapshot + uploads + exports
node src/backup.js restore .\backups\<folder>   # stop the server first
```

Restore checks integrity, swaps the data in, and keeps the previous database and folders with a `.pre-restore-<timestamp>` suffix.

## Configuration

`PORT`, `SMS_GATEWAY_PORT`, `SMS_GATEWAY_URL`, `EMAIL_GATEWAY_URL`, `JWT_SECRET`, `NODE_ENV`, `DB_FILE`, `UPLOAD_DIR`, `EXPORT_DIR` (defaults in report Appendix C).

## Formatting

Code is formatted with Prettier using the repository's `.prettierrc.json`:

```powershell
npx prettier --write "public/**/*.{html,css,js}" "server/src/**/*.js" "server/test/**/*.js"
```

Generated SQLite files, uploads, exports, and backups are local runtime data and are not committed.
