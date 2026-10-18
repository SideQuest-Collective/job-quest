// app/lib/workbook/export.js
const fs = require('fs');
const path = require('path');

const MARKER = '<!--WB-DATA-->';
const DIAGRAM_MARKER = '<!--WB-DIAGRAM-->';
const DIAGRAM_SRC = path.join(__dirname, 'diagram.js');

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
  return withDiagramScript(viewerHtml).replace(MARKER, () => inject);
}

module.exports = { buildExportHtml, withDiagramScript, MARKER, DIAGRAM_MARKER };
