// app/lib/resume/jdfetch.js
const MIN_CHARS = 500;
const MAX_PAGE_BYTES = 3145728;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', bull: '•', hellip: '…', middot: '·',
};

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
  });
}

function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|nav|header|footer|svg|iframe|template|form)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/?(p|div|ul|ol|li|h[1-6]|tr|section|article|main|table|blockquote|dd|dt)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s.split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join('\n');
}

function jobPostingFromLd(html) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html)))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const nodes = [].concat(data || [], (data && data['@graph']) || []);
    for (const n of nodes) {
      const type = n && n['@type'];
      const isPosting = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
      if (isPosting && typeof n.description === 'string') return { title: typeof n.title === 'string' ? n.title : '', description: n.description };
    }
  }
  return null;
}

function isBoardRoot(originalUrl, finalUrl) {
  if (!finalUrl || finalUrl === originalUrl) return false;
  const segs = (u) => new URL(u).pathname.split('/').filter(Boolean).length;
  const before = segs(originalUrl);
  const after = segs(finalUrl);
  return after === 0 || (before >= 2 && after <= 1);
}

function isPostingUrl(url, allowPrivate) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (allowPrivate) return true;
    let host = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    // URL canonicalization turns dotted IPv4-mapped IPv6 into two hex groups.
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
    if (mapped) {
      const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
      host = [high >> 8, high & 255, low >> 8, low & 255].join('.');
    }
    if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host)) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a, b] = host.split('.').map(Number);
      if (host === '0.0.0.0' || a === 127 || a === 10 ||
          (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
          (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function fetchJd(url, { fetchImpl = globalThis.fetch, timeoutMs = 20000, allowPrivate = false } = {}) {
  if (!url || !isPostingUrl(url, allowPrivate)) return { ok: false, reason: 'no posting URL' };
  try {
    // allowPrivate is an injected test seam; production callers leave it false.
    const signal = AbortSignal.timeout(timeoutMs);
    let currentUrl = url;
    let res;
    let hops = 0;
    for (;;) {
      if (!isPostingUrl(currentUrl, allowPrivate)) return { ok: false, reason: 'no posting URL' };
      res = await fetchImpl(currentUrl, {
        redirect: 'manual', signal,
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      });
      if (!isPostingUrl(res.url || currentUrl, allowPrivate)) {
        await res.body?.cancel();
        return { ok: false, reason: 'no posting URL' };
      }
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (!location) return { ok: false, reason: 'redirect missing location' };
      if (hops >= 5) return { ok: false, reason: 'too many redirects' };
      const nextUrl = new URL(location, currentUrl).href;
      if (!isPostingUrl(nextUrl, allowPrivate)) return { ok: false, reason: 'no posting URL' };
      currentUrl = nextUrl;
      hops++;
    }
    const finalUrl = res.url || currentUrl;
    if (res.status >= 400) return { ok: false, reason: `HTTP ${res.status}` };
    if ((hops || res.redirected) && isBoardRoot(url, finalUrl)) {
      await res.body?.cancel();
      return { ok: false, reason: `redirected to ${finalUrl}` };
    }
    const contentType = res.headers.get('content-type');
    if (contentType !== null && !/text\/html|application\/xhtml\+xml|text\/plain/i.test(contentType)) {
      return { ok: false, reason: `not an HTML page (${contentType})` };
    }
    const chunks = [];
    let bytes = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        bytes += chunk.byteLength;
        // Returning closes the iterator and cancels the remaining response stream.
        if (bytes > MAX_PAGE_BYTES) return { ok: false, reason: 'page too large' };
        chunks.push(chunk);
      }
    }
    const page = new TextDecoder().decode(Buffer.concat(chunks, bytes));
    const ld = jobPostingFromLd(page);
    let text = ld ? [ld.title, htmlToText(decodeEntities(ld.description))].filter(Boolean).join('\n\n') : '';
    if (text.length < MIN_CHARS) text = htmlToText(page);
    if (text.length < MIN_CHARS) return { ok: false, reason: `only ${text.length} characters of text` };
    return { ok: true, text, finalUrl };
  } catch (err) {
    return { ok: false, reason: `fetch failed: ${(err.cause && (err.cause.code || err.cause.message)) || err.message}` };
  }
}

module.exports = { fetchJd, htmlToText, decodeEntities, jobPostingFromLd, isBoardRoot, MIN_CHARS };
