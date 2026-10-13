const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const databaseFile = path.resolve(process.env.DB_FILE || path.join(ROOT, 'data', 'healthcare.sqlite'));
const uploadsDir = path.resolve(process.env.UPLOAD_DIR || path.join(ROOT, 'uploads'));
const exportsDir = path.resolve(process.env.EXPORT_DIR || path.join(ROOT, 'exports', 'philhealth'));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function assertDirectory(pathname, label) {
  if (!fs.existsSync(pathname) || !fs.statSync(pathname).isDirectory())
    throw new Error(`${label} is not a directory: ${pathname}`);
}

function copyDirectory(source, target) {
  fs.mkdirSync(target, { recursive: true });
  if (fs.existsSync(source)) fs.cpSync(source, target, { recursive: true, force: true, errorOnExist: false });
}

function containsPath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function createBackup(target) {
  const outputDir = path.resolve(target || path.join(ROOT, 'backups', stamp()));
  if (
    [databaseFile, uploadsDir, exportsDir].some(
      source => containsPath(outputDir, source) || containsPath(source, outputDir)
    )
  ) {
    throw new Error('Backup output must be separate from the database, upload and export folders.');
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const backupDatabase = path.join(outputDir, 'healthcare.sqlite');
  const source = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    await source.backup(backupDatabase);
  } finally {
    source.close();
  }
  copyDirectory(uploadsDir, path.join(outputDir, 'uploads'));
  copyDirectory(exportsDir, path.join(outputDir, 'exports', 'philhealth'));

  const snapshot = new Database(backupDatabase, { readonly: true, fileMustExist: true });
  const integrity = snapshot.pragma('integrity_check', { simple: true });
  const recordCount = snapshot.prepare('SELECT COUNT(*) AS count FROM patients').get().count;
  snapshot.close();
  if (integrity !== 'ok') throw new Error(`Backup database integrity check failed: ${integrity}`);
  const manifest = {
    created_at: new Date().toISOString(),
    source_database: databaseFile,
    integrity_check: integrity,
    patient_records: recordCount,
    includes: ['healthcare.sqlite', 'uploads/', 'exports/philhealth/']
  };
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`Backup created: ${outputDir}`);
}

async function restoreBackup(sourceDir) {
  const inputDir = path.resolve(sourceDir || '');
  assertDirectory(inputDir, 'Backup source');
  const backupDatabase = path.join(inputDir, 'healthcare.sqlite');
  if (!fs.existsSync(backupDatabase)) throw new Error(`Backup database was not found in ${inputDir}`);
  const check = new Database(backupDatabase, { readonly: true, fileMustExist: true });
  const integrity = check.pragma('integrity_check', { simple: true });
  check.close();
  if (integrity !== 'ok') throw new Error(`Refusing to restore a database that failed integrity_check: ${integrity}`);

  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  const restoreStamp = stamp();
  const previousDatabase = `${databaseFile}.pre-restore-${restoreStamp}`;
  const stagedDatabase = `${databaseFile}.restore-${restoreStamp}`;
  const runtimeDirs = [
    { source: path.join(inputDir, 'uploads'), target: uploadsDir },
    { source: path.join(inputDir, 'exports', 'philhealth'), target: exportsDir }
  ].map(item => ({
    ...item,
    staged: `${item.target}.restore-${restoreStamp}`,
    previous: `${item.target}.pre-restore-${restoreStamp}`,
    hadPrevious: false,
    installed: false
  }));

  for (const directory of runtimeDirs) {
    fs.mkdirSync(path.dirname(directory.target), { recursive: true });
    fs.mkdirSync(directory.staged, { recursive: true });
    if (fs.existsSync(directory.source))
      fs.cpSync(directory.source, directory.staged, { recursive: true, force: true });
  }
  if (fs.existsSync(databaseFile)) {
    const current = new Database(databaseFile, { readonly: true, fileMustExist: true });
    try {
      await current.backup(previousDatabase);
    } finally {
      current.close();
    }
  }
  const restored = new Database(backupDatabase, { readonly: true, fileMustExist: true });
  try {
    await restored.backup(stagedDatabase);
  } finally {
    restored.close();
  }

  let installedRestore = false;
  try {
    // Restore must run with the application stopped so no process has the SQLite files open.
    fs.rmSync(databaseFile, { force: true });
    fs.rmSync(`${databaseFile}-wal`, { force: true });
    fs.rmSync(`${databaseFile}-shm`, { force: true });
    fs.renameSync(stagedDatabase, databaseFile);
    installedRestore = true;
    for (const directory of runtimeDirs) {
      if (fs.existsSync(directory.target)) {
        fs.renameSync(directory.target, directory.previous);
        directory.hadPrevious = true;
      }
      fs.renameSync(directory.staged, directory.target);
      directory.installed = true;
    }
  } catch (error) {
    if (fs.existsSync(stagedDatabase)) fs.rmSync(stagedDatabase, { force: true });
    if (installedRestore) fs.rmSync(databaseFile, { force: true });
    if (fs.existsSync(previousDatabase)) fs.copyFileSync(previousDatabase, databaseFile);
    for (const directory of runtimeDirs.reverse()) {
      if (directory.installed && fs.existsSync(directory.target))
        fs.rmSync(directory.target, { recursive: true, force: true });
      if (directory.hadPrevious && fs.existsSync(directory.previous))
        fs.renameSync(directory.previous, directory.target);
      if (fs.existsSync(directory.staged)) fs.rmSync(directory.staged, { recursive: true, force: true });
    }
    throw error;
  }
  console.log(`Backup restored to ${databaseFile}`);
  if (fs.existsSync(previousDatabase)) console.log(`Previous database retained at ${previousDatabase}`);
  for (const directory of runtimeDirs)
    if (directory.hadPrevious) console.log(`Previous runtime folder retained at ${directory.previous}`);
}

async function main() {
  const [command, target] = process.argv.slice(2);
  if (command === 'create') return createBackup(target);
  if (command === 'restore') return restoreBackup(target);
  throw new Error('Usage: node src/backup.js create [output-directory] | restore <backup-directory>');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
