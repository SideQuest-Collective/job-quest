// app/lib/interview/markers.js
// Ownership rule (contract): overwrite only files carrying the marker (or absent files);
// otherwise write <name>.jq.<ext> beside the target and report the target as skipped.
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
const { MARKER_MD, GENERATED_BY } = require('./contract');

function isJson(file) { return path.extname(file).toLowerCase() === '.json'; }

function carriesMarker(file, text) {
  if (isJson(file)) {
    try {
      const v = JSON.parse(text);
      return !!v && typeof v === 'object' && !Array.isArray(v) && v._generatedBy === GENERATED_BY;
    } catch {
      return false;
    }
  }
  return String(text).split('\n', 1)[0].replace(/\r$/, '') === MARKER_MD;
}

function isOwned(file) {
  try {
    return carriesMarker(file, fs.readFileSync(file, 'utf-8'));
  } catch (error) {
    return error.code === 'ENOENT';
  }
}

function siblingPath(file) {
  const ext = path.extname(file);
  return `${file.slice(0, file.length - ext.length)}.jq${ext}`;
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, content);
    fs.renameSync(temp, file);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function writeOwned(file, content) {
  if (!carriesMarker(file, content)) throw new Error(`refusing to write unmarked content to ${file}`);
  if (isOwned(file)) {
    atomicWrite(file, content);
    return { written: file };
  }
  const sibling = siblingPath(file);
  if (!isOwned(sibling)) {
    return { skipped: { path: file, reason: 'user-owned', wroteInstead: null, siblingUserOwned: true } };
  }
  atomicWrite(sibling, content);
  return { skipped: { path: file, reason: 'user-owned', wroteInstead: sibling } };
}

module.exports = { isOwned, siblingPath, writeOwned };
