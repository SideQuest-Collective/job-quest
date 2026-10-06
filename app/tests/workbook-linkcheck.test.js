// app/tests/workbook-linkcheck.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { extractUrls, isBoardRootRedirect, checkUrl, checkLinks } = require('../lib/workbook/linkcheck');

async function withSite(fn) {
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') { res.writeHead(200); res.end('ok'); return; }
    if (req.url === '/gone') { res.writeHead(404); res.end(); return; }
    if (req.url === '/jobs/123') { res.writeHead(302, { Location: '/jobs' }); res.end(); return; }
    if (req.url === '/jobs') { res.writeHead(200); res.end('board'); return; }
    if (req.url === '/moved') { res.writeHead(301, { Location: '/ok' }); res.end(); return; }
    if (req.url === '/nohead') { res.writeHead(req.method === 'HEAD' ? 405 : 200); res.end(); return; }
    if (req.url === '/slow') { setTimeout(() => { res.writeHead(200); res.end(); }, 2000); return; }
    res.writeHead(500); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.closeAllConnections(); server.close(); }
}

test('extractUrls de-duplicates and trims punctuation', () => {
  assert.deepEqual(extractUrls('See [a](https://a.com/x). Also https://a.com/x, and http://b.org/y;'), ['https://a.com/x', 'http://b.org/y']);
});

test('isBoardRootRedirect spots a posting that now lands on the listing', () => {
  assert.equal(isBoardRootRedirect('https://h.io/acme/jobs/1', 'https://h.io/acme/jobs'), true);
  assert.equal(isBoardRootRedirect('https://h.io/acme/jobs/1', 'https://h.io/'), true);
  assert.equal(isBoardRootRedirect('https://h.io/acme/jobs/1', 'https://h.io/acme/jobs/1/'), false);
  assert.equal(isBoardRootRedirect('https://h.io/a', 'https://h.io/b'), false);
});

test('live, dead, redirected-to-board, HEAD-not-allowed, and timeout', async () => {
  await withSite(async (base) => {
    assert.equal((await checkUrl(`${base}/ok`)).dead, false);
    assert.deepEqual(await checkUrl(`${base}/gone`), { url: `${base}/gone`, status: 404, finalUrl: `${base}/gone`, dead: true, reason: 'HTTP 404' });
    const board = await checkUrl(`${base}/jobs/123`);
    assert.equal(board.dead, true);
    assert.equal(board.reason, 'redirected to board root');
    assert.equal((await checkUrl(`${base}/moved`)).dead, false);
    const nohead = await checkUrl(`${base}/nohead`);
    assert.deepEqual([nohead.status, nohead.dead], [200, false]);
    const slow = await checkUrl(`${base}/slow`, { timeoutMs: 200 });
    assert.deepEqual([slow.dead, slow.reason], [true, 'timeout']);
  });
});

test('checkLinks derives postingLive from the role URL', async () => {
  await withSite(async (base) => {
    const r = await checkLinks({ urls: [`${base}/ok`, `${base}/gone`], roleUrl: `${base}/jobs/123` });
    assert.equal(r.results.length, 3);
    assert.equal(r.postingLive, false);
    assert.equal((await checkLinks({ urls: [], roleUrl: null })).postingLive, null);
  });
});
