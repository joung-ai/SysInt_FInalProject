const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const dbFile = process.env.DB_FILE || path.resolve(__dirname, '..', 'data', 'healthcare.sqlite');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
module.exports = db;
