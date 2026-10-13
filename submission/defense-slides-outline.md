# CareLink / AlagaQ — Defense Slide Outline

**Audience:** Systems Integration and Architecture instructor and review panel.
**Goal:** show how CareLink connects the clinic visit across roles, modules, and external systems; prove it with a live demo and evidence; be clear about what is simulated.
**Length:** about 12 minutes of slides plus the live demo (Section 11.1 of the report), then questions.

The slides follow the required presentation flow in spec §20. Every member should be ready to explain the event bus, the ETL flows, and the RBAC rules.

---

## 1. Project title and team members

- CareLink / AlagaQ — Healthcare Appointment, Queue, and Patient Notification Integration System (Theme 4)
- [[Course / section / group number]] · [[Member names and roles]] · [[Instructor]]

**Visual:** logo + one line: *"One visit, connected from ticket to PhilHealth export."*

## 2. Problem and scenario

- Small clinic runs the visit on paper lists, verbal calls, paper intake, loose files, manual texts, re-typed spreadsheets.
- The data exists; it just doesn't move between the people and systems that need it.

**Visual:** five disconnected boxes (queue, intake, doctor, files, PhilHealth) with broken arrows.

## 3. Current-state process

- Walk through the current-state flow (report §2.1); point out the three worst hand-offs: verbal revision requests, re-typing for PhilHealth, manual patient follow-up.
- Note: baseline is analytical — [[validated with … / to be validated]].

**Visual:** current-state Mermaid diagram.

## 4. Target-state process

- Ticket/booking or CSV import → check-in → intake → doctor decision (approve / reject / **request revision**) → resubmission → approval → SMS + email → PhilHealth export.
- Every step is logged.

**Visual:** target-state Mermaid diagram; highlight the revision loop.

## 5. Enterprise architecture

- Business: 9 processes (BP-01–BP-09). Data: 11 entities with owners. Application: route modules + event bus + notifier. Technology: Node/Express, SQLite, vanilla JS, loopback gateway.

**Visual:** application architecture diagram (report §4.3).

## 6. Integration pattern and architecture decision

- Style: **layered modular monolith + event-driven integration.**
- Pattern: **publish/subscribe through an in-process hub**, plus **batch CSV ETL** for partners and PhilHealth; shared database with explicit table ownership.
- Key ADRs: ADR-002 (event bus), ADR-008 (commit first, then publish — notification failure never undoes a clinical decision).

**Visual:** comparison table (point-to-point vs hub-and-spoke vs shared DB vs event-driven) with the chosen row highlighted.

## 7. System prototype demonstration

- Live: public ticket on a phone → queue terminal → intake → doctor requests revision → staff resubmit → approve.
- Show role-limited navigation for Patient vs Admin.

**Visual:** switch to the browser (fallback: screenshots 01–19).

## 8. API / ETL / workflow / webhook / messaging demonstration

- REST: approval response shows `sms: sent, email: sent, transaction_id`.
- Messaging: Integrations page → click the transaction ID → event bus + SMS + email rows.
- ETL import: sample CSV → 3 imported / 1 duplicate skipped / 3 rejected with reasons.
- ETL export: PhilHealth CSV from approved records.
- Failure path: patient with no phone → SMS **failed**, approval kept.

**Visual:** live Integrations page; backup slide with the log tables from report §7.6.

## 9. Security, validation, logs, and risk controls

- RBAC + record-level rules: patients see only their own records; doctors only assigned/unassigned visits; admins cannot approve clinical records.
- Immutable audit log (database triggers); integration log with transaction IDs; notification log including failures.
- Top risks: PhilHealth layout (High), default secret (High), uploads (High) — each with a control and monitoring plan.

**Visual:** compact RBAC matrix + 3-row risk excerpt.

## 10. Testing results

- 43 automated tests, 43 passed: 15 functional, 9 integration, 9 error-handling, 7 security, 1 end-to-end, 2 backup/recovery (spec minimum: 22).
- Browser walk-through: 19 screens, 0 console errors.
- Backup → simulated failure → restore transcript.

**Visual:** results table (report §9.6).

## 11. Limitations and future enhancements

- Simulated gateway, illustrative PhilHealth layout, in-memory events without retry, single SQLite server.
- Next: real provider adapters, durable outbox with retries, official PhilHealth spec, cloud file storage, push updates.

**Visual:** two columns — "Today" vs "Next".

## 12. Individual contribution

- One line per member: role and the specific modules/documents they own.

**Visual:** contribution table (report §13).

---

### Likely panel questions (prepare answers)

1. Why not microservices? → ADR-001: one clinic, one team; module seams allow a later split.
2. What happens if the SMS provider is down? → ADR-008, EH-07: decision is committed first; failure logged with reason; dashboard counts failed integrations.
3. How do you trace one approval across systems? → Transaction ID in `integration_logs` and `notification_logs`.
4. How does a doctor get stopped from approving another doctor's patient? → `lib/access.js` record check, SC-05.
5. How is the audit log protected? → SQLite `BEFORE UPDATE/DELETE` triggers, SC-04; production would add external write-once storage.
6. How does the CSV import handle bad data? → Per-row transform/validate, duplicate detection, transactional load, per-row failure log (IT-08, §7.3).
