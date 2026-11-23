const { safeId } = require('./service');
function createRequestBoundary({ origins = process.env.JOB_QUEST_ALLOWED_ORIGINS || '', tailscaleUser = process.env.JOB_QUEST_TAILSCALE_USER || '' } = {}) {
  const configured = String(origins).split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const u = new URL(s);
    if (!['http:', 'https:'].includes(u.protocol) || u.origin !== s) throw new Error('JOB_QUEST_ALLOWED_ORIGINS must contain exact http(s) origins');
    return u;
  });
  return (req, res, next) => {
    let host;
    try { host = new URL(`http://${req.headers.host}`); } catch { return res.status(403).json({ error: 'Unrecognized request host' }); }
    if (host.username || host.password || host.pathname !== '/' || host.search || host.hash) return res.status(403).json({ error: 'Unrecognized request host' });
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(host.hostname) && (host.port || '80') === String(req.socket.localPort);
    // Serve preserves the incoming Host. Normalize its default port using each
    // configured scheme: https://device:443 and https://device are one origin.
    const matchingOrigins = configured.filter(u => new URL(`${u.protocol}//${req.headers.host}`).origin === u.origin);
    const known = matchingOrigins.length > 0;
    if (!local && !known) return res.status(403).json({ error: 'Unrecognized request host' });
    const origin = req.headers.origin;
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    const proxied = !local || configured.some(u => u.origin === origin) || ['tailscale-user-login', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'].some(h => req.headers[h] !== undefined);
    // Tailscale Serve strips spoofed identity headers and supplies its authenticated
    // identity. Trust it only through a loopback proxy, never a direct tailnet peer.
    if (!loopback || (proxied && (!configured.length || !tailscaleUser || req.headers['tailscale-user-login'] !== tailscaleUser))) return res.status(403).json({ error: 'This private dashboard requires the authorized Tailscale account' });
    if (origin && !(local && origin === `http://${host.host}`) && !configured.some(u => u.origin === origin && (local || matchingOrigins.includes(u)))) return res.status(403).json({ error: 'Request origin is not allowed' });
    if (origin === 'null' || req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Cross-site requests are not allowed' });
    if (!origin && !local && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return res.status(403).json({ error: 'A trusted request origin is required' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && (Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding']) && !req.is('application/json')) return res.status(415).json({ error: 'Use application/json for this request' });
    next();
  };
}
function validConversationId(id) { return id === undefined || (safeId(id) && id.length <= 128); }
module.exports = { createRequestBoundary, validConversationId };
