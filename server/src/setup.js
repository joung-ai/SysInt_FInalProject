const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data');
const dbFile = process.env.DB_FILE || path.join(dataDir, 'healthcare.sqlite');
const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf8');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.resolve(process.env.UPLOAD_DIR || path.join(root, 'uploads')), { recursive: true });
fs.mkdirSync(path.resolve(process.env.EXPORT_DIR || path.join(root, 'exports', 'philhealth')), { recursive: true });
fs.mkdirSync(path.dirname(path.resolve(dbFile)), { recursive: true });

const db = new Database(dbFile);
db.pragma('foreign_keys = ON');
db.exec(schema);

const columnsOf = table => new Set(db.pragma(`table_info(${table})`).map(column => column.name));

// Columns added after the first release. ALTER TABLE ADD COLUMN keeps existing rows.
const addedColumns = [
  ['appointments', 'queue_order', 'INTEGER'],
  ['assets', 'category', "TEXT NOT NULL DEFAULT 'Other'"],
  ['consultations', 'revision', 'INTEGER NOT NULL DEFAULT 1'],
  ['notification_logs', 'recipient_role', 'TEXT'],
  ['notification_logs', 'transaction_id', 'TEXT']
];
for (const [table, column, definition] of addedColumns) {
  if (!columnsOf(table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// SQLite cannot change a CHECK constraint in place, so tables whose allowed statuses grew are rebuilt
// with SQLite's documented procedure: create the new table, copy rows, drop the old one, rename.
function rebuildIfMissing(table, marker) {
  const current = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!current || current.sql.includes(marker)) return;
  const definition = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`));
  if (!definition) throw new Error(`Schema definition for ${table} was not found.`);
  const shared = [...columnsOf(table)].join(', ');
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`CREATE TABLE ${table}__new (${definition[1]}\n)`);
    db.exec(`INSERT INTO ${table}__new (${shared}) SELECT ${shared} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${table}__new RENAME TO ${table}`);
  })();
  db.pragma('foreign_keys = ON');
  console.log(`Migrated ${table} to the current status set.`);
}
rebuildIfMissing('consultations', 'revision_requested');
rebuildIfMissing('asset_versions', 'revision_requested');

// Re-run the schema so indexes on rebuilt tables exist again, then add the queue-order index.
db.exec(schema);
db.exec(`
  UPDATE appointments SET queue_order = queue_number WHERE queue_order IS NULL AND queue_number IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_appointments_queue_order ON appointments(date(scheduled_at), queue_order, queue_number);
`);

const problems = db.pragma('foreign_key_check');
if (problems.length) throw new Error(`Foreign key check failed after setup: ${JSON.stringify(problems)}`);
db.close();
console.log(`SQLite schema is ready at ${path.relative(root, path.resolve(dbFile)) || dbFile}`);
