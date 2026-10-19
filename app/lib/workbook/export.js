// app/lib/workbook/export.js
const fs = require('fs');
const path = require('path');

const MARKER = '<!--WB-DATA-->';
const DIAGRAM_MARKER = '<!--WB-DIAGRAM-->';
const DIAGRAM_SRC = path.join(__dirname, 'diagram.js');
const PUBLIC_DIR = path.resolve(__dirname, '../../public');
// Only these bundled viewer assets are read; HTML cannot select arbitrary files.
const OFFLINE_ASSETS = new Map([
  ['/theme-tokens.css', { file: 'theme-tokens.css', tag: 'style' }],
  ['/theme.js', { file: 'theme.js', tag: 'script' }],
  ['/workbook-theme.css', { file: 'workbook-theme.css', tag: 'style' }],
  ['/brand/job-quest-icon.svg', { file: 'brand/job-quest-icon.svg', mime: 'image/svg+xml' }],
  ['/brand/favicon-32.png', { file: 'brand/favicon-32.png', mime: 'image/png' }],
  ['/brand/apple-touch-icon.png', { file: 'brand/apple-touch-icon.png', mime: 'image/png' }],
  ['/brand/job-quest-mark.svg', { file: 'brand/job-quest-mark.svg', mime: 'image/svg+xml' }],
]);

function withOfflineAssets(viewerHtml) {
  return String(viewerHtml).replace(/<(?:link|img)\b[^>]*>|<script\b[^>]*\bsrc\s*=\s*(["'])[^"']+\1[^>]*>\s*<\/script\s*>/gi, tag => {
    const attribute = tag.match(/\b(?:href|src)\s*=\s*(["'])([^"']+)\1/i);
    const asset = attribute && OFFLINE_ASSETS.get(attribute[2]);
    if (!asset) return tag;
    if (asset.mime) {
      const source = fs.readFileSync(path.join(PUBLIC_DIR, asset.file));
      const dataUri = `data:${asset.mime};base64,${source.toString('base64')}`;
      return tag.replace(attribute[0], () => attribute[0].replace(attribute[2], () => dataUri));
    }
    const source = fs.readFileSync(path.join(PUBLIC_DIR, asset.file), 'utf-8');
    if (new RegExp(`<\\/${asset.tag}`, 'i').test(source)) {
      throw new Error(`${asset.file} must not contain a closing ${asset.tag} tag`);
    }
    return `<${asset.tag}>\n${source}\n</${asset.tag}>`;
  });
}

// The viewer draws ```diagram blocks with lib/workbook/diagram.js, inlined so offline copies work too.
function withDiagramScript(viewerHtml) {
  const src = fs.readFileSync(DIAGRAM_SRC, 'utf-8');
  if (/<\/script/i.test(src)) throw new Error('diagram.js must not contain a closing script tag');
  return String(viewerHtml).replace(DIAGRAM_MARKER, () => `<script>\n${src}\n</script>`);
}

function buildExportHtml(viewerHtml, data) {
  if (!String(viewerHtml).includes(MARKER)) throw new Error(`viewer template is missing the ${MARKER} marker`);
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const inject = `<script>window.WB_OFFLINE=true;</script>\n<script type="application/json" id="wb-data">${json}</script>`;
  return withOfflineAssets(withDiagramScript(viewerHtml)).replace(MARKER, () => inject);
}

module.exports = { buildExportHtml, withDiagramScript, MARKER, DIAGRAM_MARKER };
