const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, data);
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* Cleanup must not mask the write or rename error. */ }
    throw error;
  }
}

module.exports = { writeFileAtomic };
