// app/tests/resume-jdfetch.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fetchJd, htmlToText, isBoardRoot } = require('../lib/resume/jdfetch');

const LONG = 'We are hiring a Senior Software Engineer to build payment systems in Python and PostgreSQL on AWS. '.repeat(8);

async function serve(routes) {
  const server = http.createServer((req, res) => {
    const h = routes[req.url];
    if (!h) { res.writeHead(404); res.end('nope'); return; }
    h(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
const html = (body) => (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); };
const redirect = (to) => (req, res) => { res.writeHead(302, { location: to }); res.end(); };

test('htmlToText decodes entities and keeps list structure', () => {
  assert.equal(htmlToText('<p>A &amp; B&#39;s &#x2014; &nbsp;C</p><ul><li>One</li><li>Two</li></ul>'), "A & B's — C\n- One\n- Two");
});

test('isBoardRoot', () => {
  assert.equal(isBoardRoot('https://boards.example.com/acme/jobs/123', 'https://boards.example.com/acme'), true);
  assert.equal(isBoardRoot('https://boards.example.com/acme/jobs/123', 'https://boards.example.com/'), true);
  assert.equal(isBoardRoot('https://ex.com/jobs/1/apply', 'https://ex.com/jobs/1'), false);
  assert.equal(isBoardRoot('https://ex.com/a/b', 'https://ex.com/a/b'), false);
});

test('fetchJd: strips scripts, styles, nav and footer from a normal posting', async (t) => {
  const s = await serve({ '/acme/jobs/1': html(`<html><head><style>.a{}</style><script>var secret = 1;</script></head><body><nav>Home About</nav><main><h1>Senior Software Engineer</h1><p>${LONG}</p><ul><li>Kafka</li><li>Redis &amp; caching</li></ul></main><footer>Copyright Acme</footer></body></html>`) });
  t.after(s.close);
  const r = await fetchJd(`${s.base}/acme/jobs/1`, { allowPrivate: true });
  assert.equal(r.ok, true, r.reason);
  assert.match(r.text, /^Senior Software Engineer\n/);
  assert.match(r.text, /- Redis & caching/);
  assert.ok(!/secret|Home About|Copyright/.test(r.text), r.text);
});

test('fetchJd: a client-rendered page falls back to JobPosting JSON-LD', async (t) => {
  const ld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Data Engineer', description: `&lt;p&gt;${LONG}&lt;/p&gt;` });
  const s = await serve({ '/acme/jobs/2': html(`<html><body><div id="root"></div><script type="application/ld+json">${ld}</script></body></html>`) });
  t.after(s.close);
  const r = await fetchJd(`${s.base}/acme/jobs/2`, { allowPrivate: true });
  assert.equal(r.ok, true, r.reason);
  assert.match(r.text, /^Data Engineer\n\nWe are hiring/);
});

test('fetchJd: a redirect to the board root is "posting unavailable", a deeper redirect is fine', async (t) => {
  const s = await serve({
    '/acme/jobs/3': redirect('/acme'),
    '/acme': html(`<html><body><h1>All jobs at Acme</h1><p>${LONG}</p></body></html>`),
    '/acme/jobs/4/apply': redirect('/acme/jobs/4'),
    '/acme/jobs/4': html(`<html><body><p>${LONG}</p></body></html>`),
  });
  t.after(s.close);
  const closed = await fetchJd(`${s.base}/acme/jobs/3`, { allowPrivate: true });
  assert.equal(closed.ok, false);
  assert.match(closed.reason, /^redirected to .*\/acme$/);
  const moved = await fetchJd(`${s.base}/acme/jobs/4/apply`, { allowPrivate: true });
  assert.equal(moved.ok, true, moved.reason);
  assert.match(moved.finalUrl, /\/acme\/jobs\/4$/);
});

test('fetchJd: HTTP errors, short pages, and bad URLs', async (t) => {
  const s = await serve({
    '/acme/jobs/6': html('<html><body><p>Loading...</p></body></html>'),
    '/acme/jobs/7': (req, res) => { res.writeHead(500); res.end('boom'); },
  });
  t.after(s.close);
  assert.deepEqual(await fetchJd(`${s.base}/acme/jobs/5`, { allowPrivate: true }), { ok: false, reason: 'HTTP 404' });
  assert.deepEqual(await fetchJd(`${s.base}/acme/jobs/7`, { allowPrivate: true }), { ok: false, reason: 'HTTP 500' });
  assert.match((await fetchJd(`${s.base}/acme/jobs/6`, { allowPrivate: true })).reason, /^only \d+ characters of text$/);
  assert.deepEqual(await fetchJd(''), { ok: false, reason: 'no posting URL' });
  assert.deepEqual(await fetchJd('ftp://x/y'), { ok: false, reason: 'no posting URL' });
  assert.match((await fetchJd('http://127.0.0.1:1/x', { allowPrivate: true })).reason, /^fetch failed: /);
});

test('fetchJd: body network errors and timeouts return failure results', async () => {
  const url = 'https://example.com/acme/jobs/8';
  for (const [error, message] of [
    [new Error('terminated', { cause: { code: 'ECONNRESET' } }), 'ECONNRESET'],
    [new DOMException('The operation was aborted due to timeout', 'TimeoutError'), 'The operation was aborted due to timeout'],
  ]) {
    const fetchImpl = async () => new Response(new ReadableStream({
      pull(controller) { controller.error(error); },
    }));
    assert.deepEqual(await fetchJd(url, { fetchImpl }), { ok: false, reason: `fetch failed: ${message}` });
  }
});

test('fetchJd: rejects non-page content types before reading the body', async () => {
  for (const type of ['application/pdf', 'application/octet-stream', 'image/png']) {
    let reads = 0;
    const response = new Response(LONG, { headers: { 'content-type': type } });
    const fetchImpl = async () => response;
    const originalText = response.text.bind(response);
    response.text = async () => { reads++; return originalText(); };
    assert.deepEqual(await fetchJd('https://example.com/jobs/1', { fetchImpl }), {
      ok: false, reason: `not an HTML page (${type})`,
    });
    assert.equal(reads, 0);
    assert.equal(response.bodyUsed, false);
  }
});

test('fetchJd: stops and cancels a body exceeding 3145728 bytes', async () => {
  let reads = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      reads++;
      if (reads === 1) controller.enqueue(Buffer.from('é'.repeat(1572864)));
      else if (reads < 4) controller.enqueue(Buffer.from('x'));
      else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const fetchImpl = async () => new Response(body, { headers: { 'content-type': 'text/html' } });
  assert.deepEqual(await fetchJd('https://example.com/jobs/1', { fetchImpl }), {
    ok: false, reason: 'page too large',
  });
  assert.equal(reads, 2, 'must stop at the first byte over the limit');
  assert.equal(cancelled, true);
});

test('fetchJd: accepts allowed or absent content types and the exact byte limit', async () => {
  for (const type of ['text/html; charset=utf-8', 'application/xhtml+xml', 'text/plain', 'TEXT/HTML', null]) {
    const response = new Response(Buffer.from('é'.repeat(1572864)), {
      headers: type ? { 'content-type': type } : {},
    });
    const result = await fetchJd('https://example.com/jobs/1', { fetchImpl: async () => response });
    assert.equal(result.ok, true, `${type}: ${result.reason}`);
    assert.equal(result.text.length, 1572864);
  }
});

test('fetchJd: rejects private input hosts before fetching', async () => {
  const hosts = [
    '127.0.0.1', '127.255.255.255', 'localhost', 'jobs.localhost', 'LOCALHOST.',
    '0.0.0.0', '10.0.0.5', '10.255.255.255', '172.16.0.1', '172.31.255.255',
    '192.168.0.1', '169.254.10.1', '[::1]', '[0:0:0:0:0:0:0:1]',
    '[fc00::1]', '[fdff:ffff::1]',
  ];
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(LONG); };
  for (const host of hosts) {
    assert.deepEqual(await fetchJd(`http://${host}/jobs/1`, { fetchImpl }), {
      ok: false, reason: 'no posting URL',
    }, host);
  }
  assert.equal(calls, 0);
});

test('fetchJd: rejects private final URLs before reading redirected responses', async () => {
  for (const host of ['10.0.0.5', 'localhost', '[::1]', '[fd00::1]']) {
    const response = new Response(LONG);
    Object.defineProperties(response, {
      url: { value: `http://${host}/` }, redirected: { value: true },
    });
    assert.deepEqual(await fetchJd('https://example.com/jobs/1', { fetchImpl: async () => response }), {
      ok: false, reason: 'no posting URL',
    }, host);
    assert.equal(response.bodyUsed, true, 'rejected redirected body is cancelled');
  }
});

test('fetchJd: allows public hosts and explicit private opt-in', async () => {
  for (const host of ['localhost.example.com', '128.0.0.1', '172.15.255.255', '172.32.0.0', '192.169.0.1', '169.255.0.1', '[fbff::1]', '[fe00::1]']) {
    const result = await fetchJd(`https://${host}/jobs/1`, { fetchImpl: async () => new Response(LONG) });
    assert.equal(result.ok, true, `${host}: ${result.reason}`);
  }
  const response = new Response(LONG);
  Object.defineProperty(response, 'url', { value: 'http://10.0.0.5/jobs/1' });
  const result = await fetchJd('http://127.0.0.1/jobs/1', { allowPrivate: true, fetchImpl: async () => response });
  assert.equal(result.ok, true, result.reason);
});

test('fetchJd: falls back to the error message for unhelpful causes', async () => {
  for (const cause of [{}, 'socket failed', { code: '', message: '' }]) {
    const fetchImpl = async () => { throw new Error('connection failed', { cause }); };
    assert.deepEqual(await fetchJd('https://example.com/jobs/1', { fetchImpl }), {
      ok: false, reason: 'fetch failed: connection failed',
    });
  }
});

for (const host of ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:a00:1]', '[::ffff:c0a8:101]', '100.64.0.0', '100.127.255.255', '[::ffff:6440:1]']) {
  test(`fetchJd blocks mapped/private host ${host} before any request`, async () => {
    let calls = 0;
    const r = await fetchJd(`http://${host}/jobs/1`, { fetchImpl: async () => { calls++; return new Response(LONG); } });
    assert.equal(r.ok, false);
    assert.equal(calls, 0);
  });
}

test('fetchJd validates every redirect before requesting it and cancels redirect bodies', async () => {
  const calls = [];
  let cancelled = 0;
  const r = await fetchJd('https://example.com/jobs/1', { fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'manual');
    return new Response(new ReadableStream({ pull(c) { c.enqueue(Buffer.from(LONG)); c.close(); }, cancel() { cancelled++; } }, { highWaterMark: 0 }), {
      status: 302, headers: { location: calls.length === 1 ? '/jobs/2' : 'http://127.0.0.1/private' },
    });
  } });
  assert.deepEqual(calls, ['https://example.com/jobs/1', 'https://example.com/jobs/2']);
  assert.equal(r.ok, false);
  assert.equal(cancelled, 2);
});

test('fetchJd follows at most five redirect hops', async () => {
  for (const redirects of [5, 6]) {
    let calls = 0;
    let cancelled = 0;
    const r = await fetchJd('https://example.com/jobs/0', { fetchImpl: async () => {
      calls++;
      if (calls > redirects) return new Response(LONG);
      return new Response(new ReadableStream({ pull(c) { c.enqueue(Buffer.from(LONG)); c.close(); }, cancel() { cancelled++; } }, { highWaterMark: 0 }), { status: 307, headers: { location: `/jobs/${calls}` } });
    } });
    assert.equal(r.ok, redirects === 5, r.reason);
    assert.equal(calls, 6);
    assert.equal(cancelled, redirects);
  }
});
