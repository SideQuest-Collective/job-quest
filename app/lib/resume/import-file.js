// Extract only the uploaded document the user selected. Never execute document code.
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { buildLines } = require('./grade');
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_TEXT = 100000;
function problem(status, message) { return Object.assign(new Error(message), { status }); }
function decodeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, entity) => {
    const known = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (known[entity]) return known[entity];
    const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  });
}
async function extractResume(file) {
  const format = path.extname(file).slice(1).toLowerCase();
  if (!['pdf', 'docx', 'txt', 'md'].includes(format)) throw problem(400, 'Choose a PDF, Word (.docx), Markdown or text resume. Save older .doc files as .docx or PDF first.');
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw problem(413, 'Choose a resume file smaller than 10 MB.');
  let text;
  try {
    if (format === 'pdf') {
      const lib = require('pdfjs-dist/legacy/build/pdf.js');
      const doc = await lib.getDocument({ data: new Uint8Array(fs.readFileSync(file)), disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
      try {
        if (doc.numPages > 50) throw problem(413, 'Choose a resume with 50 pages or fewer.');
        const lines = [];
        for (let p = 1; p <= doc.numPages; p++) {
          const page = await doc.getPage(p);
          lines.push(...buildLines((await page.getTextContent()).items, p));
          page.cleanup();
        }
        text = lines.map(l => l.text).join('\n');
      } finally { await doc.destroy(); }
    } else if (format === 'docx') {
      const zip = new AdmZip(file);
      const parts = zip.getEntries().filter(e => /^word\/(document|header\d*|footer\d*)\.xml$/.test(e.entryName));
      if (!parts.some(e => e.entryName === 'word/document.xml')) throw problem(422, 'This file is not a readable Word document.');
      if (parts.reduce((n, e) => n + e.header.size, 0) > MAX_BYTES) throw problem(413, 'The Word document contains too much text.');
      text = parts.map(e => decodeXml(e.getData().toString('utf8')
        .replace(/<w:(?:tab|br|cr)\b[^>]*\/?\s*>/g, '\n')
        .replace(/<\/w:(?:p|tr)>/g, '\n').replace(/<\/w:tc>/g, '\t')
        .replace(/<[^>]*>/g, ''))).join('\n');
    } else text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.status) throw err;
    throw problem(422, 'Could not read this resume. Try an unlocked PDF, a .docx file, or paste its text into a .txt file.');
  }
  text = text.replace(/\r/g, '').trim();
  if (text.length < 20) throw problem(422, 'No readable resume text was found. Scanned PDFs need OCR first; upload a text-based PDF or Word document instead.');
  if (text.length > MAX_TEXT) throw problem(413, 'This document is too long to import. Choose the resume itself (under 100,000 characters).');
  return { text, format, characters: text.length };
}
module.exports = { extractResume, MAX_BYTES };
