# CareLink / AlagaQ — Final Submission Pack

Everything required by spec §19 that lives in this repository.

| Spec §19 item | Where |
| --- | --- |
| 1. Final project document | [`final-report.md`](final-report.md) — follows the required table of contents (export to PDF for submission) |
| 2. Working prototype | Run locally (below); see report §10 |
| 3. Source code | [`../public`](../public), [`../server`](../server) |
| 4. Database / migration file | [`../server/schema.sql`](../server/schema.sql), [`../server/src/setup.js`](../server/src/setup.js) (migrations), [`../server/src/seed.js`](../server/src/seed.js) |
| 5. Screenshots of system features | [`screenshots/`](screenshots/) — 19 screens, including all 12 required |
| 6. Integration evidence | [`evidence/api-evidence.json`](evidence/api-evidence.json), [`evidence/philhealth-latest.csv`](evidence/philhealth-latest.csv), screenshot `13-integrations-log.png` |
| 7. Testing results | [`test-results.txt`](test-results.txt) — 43 tests, 43 passed |
| 8. Backup and recovery evidence | [`evidence/backup-restore-log.txt`](evidence/backup-restore-log.txt), tests BR-01/BR-02 |
| 9. Presentation slides | [`defense-slides-outline.md`](defense-slides-outline.md) — build the deck from this outline |
| 10. Individual contribution sheet | Report §13 (fill in names) |

Suggested file name for the PDF: `SECTION_GROUPNO_CARELINK_HEALTHCARE_INTEGRATION_FINALPROJECT.pdf`.

## Run the system

Requires Node.js 18.17 or newer. From the project root:

```powershell
cd server
npm install
npm run setup
npm run seed
npm start
```

Open `http://localhost:3000`. Demo accounts (password `SysInt2026!`): `admin`, `doctor1`, `doctor2`, `clinic1`, `patient1`.

Run the tests from `server/` with `npm test`. Create a backup with `node src/backup.js create`; stop the server before `node src/backup.js restore <backup-folder>`.

## Before you submit

- Replace every `[[...]]` placeholder in the report and slide outline (course, section, group, members, instructor, date, contributions).
- Export `final-report.md` to PDF (the Mermaid diagrams render in VS Code's Markdown preview with a Mermaid extension, on GitHub, or at mermaid.live).
- Build the slide deck from the outline.
- Use only the seeded fictional data. Do not claim real SMS delivery or an official PhilHealth interface; both are simulated and labelled as such.
