// app/lib/workbook/linkcheck.js
function extractUrls(markdown) {
  const out = [];
  const re = /https?:\/\/[^\s)<>\]"'`]+/g;
  let m;
  while ((m = re.exec(String(markdown || '')))) {
    const url = m[0].replace(/[.,;:]+$/, '');
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

function isBoardRootRedirect(original, final) {
  if (!final || final === original) return false;
  let a;
  let b;
  try { a = new URL(original); b = new URL(final); } catch { return false; }
  const ap = a.pathname.replace(/\/+$/, '');
  const bp = b.pathname.replace(/\/+$/, '');
  if (ap === bp) return false;
  if (bp === '') return true;
  return a.host === b.host && ap.startsWith(`${bp}/`);
}

async function checkUrl(url, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const attempt = async (method) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { method, redirect: 'follow', signal: ctl.signal });
      return { status: r.status, finalUrl: r.url || url };
    } finally {
      clearTimeout(timer);
    }
  };
  let res = null;
  let reason = null;
  try {
    res = await attempt('HEAD');
    if ([403, 405, 501].includes(res.status)) res = await attempt('GET');
  } catch {
    try { res = await attempt('GET'); } catch (err) { reason = err && err.name === 'AbortError' ? 'timeout' : String((err && err.message) || err); }
  }
  if (!res) return { url, status: null, finalUrl: null, dead: true, reason };
  const toRoot = isBoardRootRedirect(url, res.finalUrl);
  const dead = res.status >= 400 || toRoot;
  return { url, status: res.status, finalUrl: res.finalUrl, dead, reason: res.status >= 400 ? `HTTP ${res.status}` : toRoot ? 'redirected to board root' : null };
}

async function checkLinks({ urls = [], roleUrl = null, fetchImpl, timeoutMs, concurrency = 4 }) {
  const list = [...urls];
  if (roleUrl && !list.includes(roleUrl)) list.unshift(roleUrl);
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      results[i] = await checkUrl(list[i], { fetchImpl, timeoutMs });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  const role = roleUrl ? results.find((r) => r.url === roleUrl) : null;
  return { results, postingLive: role ? !role.dead : null };
}

module.exports = { extractUrls, isBoardRootRedirect, checkUrl, checkLinks };
