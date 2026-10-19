const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildExportHtml, withDiagramScript } = require('../lib/workbook/export');

const publicDir = path.resolve(__dirname, '../public');
const template = () => fs.readFileSync(path.join(publicDir, 'workbook.html'), 'utf-8');
const minimal = '<head><link rel="stylesheet" href="/theme-tokens.css"><script src="/theme.js"></script><link rel="stylesheet" href="/workbook-theme.css"></head><!--WB-DATA-->';
const brandAssets = [
  ['brand/job-quest-icon.svg', 'image/svg+xml'],
  ['brand/favicon-32.png', 'image/png'],
  ['brand/apple-touch-icon.png', 'image/png'],
  ['brand/job-quest-mark.svg', 'image/svg+xml'],
];

test('real workbook export embeds its theme assets and escaped data for offline use', () => {
  const data = { meta: { title: 'A </script><img src=x> & workbook' }, content: { chapters: [], questions: [] } };
  const html = buildExportHtml(template(), data);
  for (const file of ['theme-tokens.css', 'theme.js', 'workbook-theme.css']) {
    assert.ok(html.includes(fs.readFileSync(path.join(publicDir, file), 'utf-8')), `${file} is embedded`);
  }
  assert.match(html, /window\.JobQuestTheme\s*=/);
  assert.match(html, /window\.WB_OFFLINE=true/);
  const resources = [...html.matchAll(/<(?:link|script|img)\b[^>]*(?:href|src)\s*=\s*["']([^"']+)/gi)].map(match => match[1]);
  assert.equal(resources.length, brandAssets.length, 'only embedded brand images and icons retain resource attributes');
  assert.ok(resources.every(url => url.startsWith('data:')), 'no offline network resource references remain');
  for (const [file, mime] of brandAssets) {
    const dataUri = `data:${mime};base64,${fs.readFileSync(path.join(publicDir, file)).toString('base64')}`;
    assert.ok(resources.includes(dataUri), `${file} is embedded byte for byte`);
  }
  assert.match(html, /<img\b[^>]*src="data:image\/svg\+xml;base64,/);
  assert.match(html, /<link\b[^>]*rel="apple-touch-icon"[^>]*href="data:image\/png;base64,/);
  assert.doesNotMatch(html, /@import\b|url\(\s*["']?(?:https?:|\/)/i, 'CSS does not fetch fonts or other remote assets');
  assert.doesNotMatch(html, /<!--WB-(?:DATA|DIAGRAM)-->/);
  assert.doesNotMatch(html, /<img src=x>/);
  assert.deepEqual(JSON.parse(html.match(/id="wb-data">([\s\S]*?)<\/script>/)[1]), data);
  for (const script of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (!/application\/json/.test(script[1] || '')) new vm.Script(script[2]);
  }
});

test('served viewer retains asset links while diagrams are embedded', () => {
  const source = template();
  const html = withDiagramScript(source);
  assert.match(html, /href="\/theme-tokens\.css"/);
  assert.match(html, /src="\/theme\.js"/);
  assert.match(html, /href="\/workbook-theme\.css"/);
  for (const [file] of brandAssets) assert.ok(html.includes(`"/${file}"`), `${file} remains a local online reference`);
  assert.match(html, /<!--WB-DATA-->/);
  assert.doesNotMatch(html, /<!--WB-DIAGRAM-->/);
});

test('small legacy export fixtures still work without theme assets', () => {
  const html = buildExportHtml('<body><!--WB-DATA--></body>', { meta: {} });
  assert.match(html, /id="wb-data"/);
  assert.doesNotMatch(html, /JobQuestTheme/);
  assert.throws(() => buildExportHtml('<body></body>', {}), /WB-DATA/);
});

for (const [file, source, closingTag] of [
  ['theme-tokens.css', 'body{} </StYlE><script>bad()</script>', 'style'],
  ['workbook-theme.css', '</style >', 'style'],
  ['theme.js', 'const value="</ScRiPt>";', 'script'],
]) {
  test(`export refuses unsafe closing tags in ${file}`, t => {
    const read = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', function(filename, ...args) {
      return filename === path.join(publicDir, file) ? source : read.call(this, filename, ...args);
    });
    assert.throws(() => buildExportHtml(minimal, {}), new RegExp(`${file.replace('.', '\\.')} must not contain a closing ${closingTag} tag`));
  });
}

test('missing bundled assets fail the export clearly instead of producing an unstyled copy', t => {
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function(filename, ...args) {
    if (filename === path.join(publicDir, 'theme.js')) throw new Error('ENOENT: theme.js');
    return read.call(this, filename, ...args);
  });
  assert.throws(() => buildExportHtml(minimal, {}), /ENOENT: theme\.js/);
});

test('asset URLs cannot select arbitrary files', t => {
  const read = fs.readFileSync;
  const paths = [];
  t.mock.method(fs, 'readFileSync', function(filename, ...args) {
    paths.push(filename);
    return read.call(this, filename, ...args);
  });
  const html = buildExportHtml('<link rel="stylesheet" href="/../../private.css"><link rel="icon" href="/brand/../../private.png"><img src="/brand/private.svg"><img src="/brand/job-quest-mark.svg?file=../../private"><!--WB-DATA-->', {});
  assert.match(html, /href="\/\.\.\/\.\.\/private\.css"/);
  assert.match(html, /href="\/brand\/\.\.\/\.\.\/private\.png"/);
  assert.match(html, /src="\/brand\/private\.svg"/);
  assert.match(html, /src="\/brand\/job-quest-mark\.svg\?file=\.\.\/\.\.\/private"/);
  assert.equal(paths.length, 1);
  assert.equal(path.basename(paths[0]), 'diagram.js');
});
