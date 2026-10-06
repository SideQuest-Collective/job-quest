// Session records, an idempotency hash, and per-folder ingestion locks.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { assertFolderName } = require('./contract');

function recordsDir(dataDir) { return path.join(dataDir, 'interview-sessions'); }

function recordPath(dataDir, folder) {
  const name = assertFolderName(folder);
  return path.join(recordsDir(dataDir), `${name}.json`);
}

function readRecord(dataDir, folder) {
  const file = recordPath(dataDir, folder);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeRecord(dataDir, record) {
  const file = recordPath(dataDir, record.folder);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(16).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(record, null, 2));
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return record;
}

function listRecords(dataDir) {
  const dir = recordsDir(dataDir);
  let files;
  try { files = fs.readdirSync(dir); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return files.filter((file) => file.endsWith('.json') && !file.startsWith('.'))
    .sort().reverse()
    .map((file) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { return null; }
    })
    .filter(Boolean);
}

function sessionHash(dir) {
  const hash = crypto.createHash('sha256');
  for (const name of ['session.json', 'debrief.md']) {
    try { hash.update(fs.readFileSync(path.join(dir, name))); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return hash.digest('hex');
}

// Read the token and metadata from one open file, even if its path is replaced.
function readLock(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    return { token: fs.readFileSync(fd, 'utf8'), ino: stat.ino, dev: stat.dev, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function removeUnchangedLock(file, expected) {
  const current = readLock(file);
  if (!current) return true;
  if (current.token !== expected.token || current.ino !== expected.ino ||
      current.dev !== expected.dev || current.mtimeMs !== expected.mtimeMs) return false;
  try { fs.unlinkSync(file); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return true;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withLock(dataDir, folder, fn, { waitMs = 15000, staleMs = 900000 } = {}) {
  const name = assertFolderName(folder);
  const dir = recordsDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, `.${name}.lock`);
  const token = `${process.pid}:${crypto.randomBytes(16).toString('hex')}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    let fd;
    try { fd = fs.openSync(lock, 'wx'); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (fd !== undefined) {
      try {
        try { fs.writeFileSync(fd, token); } finally { fs.closeSync(fd); }
      } catch (error) {
        fs.unlinkSync(lock);
        throw error;
      }
      try {
        return await fn();
      } finally {
        try {
          const owned = readLock(lock);
          if (owned && owned.token === token) removeUnchangedLock(lock, owned);
        } catch { /* Release errors must not replace the callback's outcome. */ }
      }
    }
    const existing = readLock(lock);
    if (!existing) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`busy: another ingest of ${name} is running`);
      await sleep(Math.min(100, left));
      continue;
    }
    if (Date.now() - existing.mtimeMs > staleMs && removeUnchangedLock(lock, existing)) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`busy: another ingest of ${name} is running`);
    await sleep(Math.min(100, remaining));
  }
}

module.exports = { recordsDir, readRecord, writeRecord, listRecords, sessionHash, withLock };
