// app/lib/workbook/pdf.js
// Prints HTML to PDF with a locally installed Chromium-family browser (Chrome, Chromium, Edge, Brave),
// so no extra npm dependency is needed. JOB_QUEST_PDF_BROWSER overrides the search.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

class PdfUnavailableError extends Error {}

function findBrowser(env = process.env, platform = process.platform, exists = fs.existsSync) {
  if (env.JOB_QUEST_PDF_BROWSER) return exists(env.JOB_QUEST_PDF_BROWSER) ? env.JOB_QUEST_PDF_BROWSER : null;
  const home = env.HOME || os.homedir();
  const list = [...(CANDIDATES[platform] || [])];
  if (platform === 'darwin') list.push(...CANDIDATES.darwin.map((p) => path.join(home, p)));
  return list.find((p) => exists(p)) || null;
}

function htmlToPdf(html, { browser = findBrowser(), timeoutMs = 90000 } = {}) {
  if (!browser) {
    return Promise.reject(new PdfUnavailableError('No Chrome, Chromium, Edge or Brave found to make the PDF. Install one, or set JOB_QUEST_PDF_BROWSER to its path.'));
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-pdf-'));
  const src = path.join(dir, 'workbook.html');
  const out = path.join(dir, 'workbook.pdf');
  fs.writeFileSync(src, html);
  const args = ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${path.join(dir, 'profile')}`, `--print-to-pdf=${out}`, `file://${src}`];
  return new Promise((resolve, reject) => {
    execFile(browser, args, { timeout: timeoutMs }, (err) => {
      try {
        if (fs.existsSync(out) && fs.statSync(out).size > 0) resolve(fs.readFileSync(out));
        else reject(new Error(`the browser did not write a PDF${err ? `: ${String(err.message || err).split('\n')[0]}` : ''}`));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

module.exports = { findBrowser, htmlToPdf, PdfUnavailableError };
