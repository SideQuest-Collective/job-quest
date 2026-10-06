// app/lib/workbook/export.js
const MARKER = '<!--WB-DATA-->';

function buildExportHtml(viewerHtml, data) {
  if (!String(viewerHtml).includes(MARKER)) throw new Error(`viewer template is missing the ${MARKER} marker`);
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const inject = `<script>window.WB_OFFLINE=true;</script>\n<script type="application/json" id="wb-data">${json}</script>`;
  return String(viewerHtml).replace(MARKER, () => inject);
}

module.exports = { buildExportHtml, MARKER };
