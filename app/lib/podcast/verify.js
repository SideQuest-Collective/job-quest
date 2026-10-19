// app/lib/podcast/verify.js
// Checks that a Gemini key can actually record audio before any episode work starts.
// One short line is synthesised; the response is classified into a code with a plain-English fix.
const { ENDPOINT, requestBody, extractAudio } = require('./tts');

const PROBE_TEXT = 'Daily Drop voice check.';
const KEY_PAGE = 'https://aistudio.google.com/apikey';
const BILLING_PAGE = 'https://ai.studio/projects';

const REMEDIATION = {
  'no-key': `Paste a Gemini API key on the Daily Drop page. Create one at ${KEY_PAGE}.`,
  billing: `The Google AI Studio project behind this key has no prepaid credits. Add credits at ${BILLING_PAGE}, or create a key under a project on the free tier at ${KEY_PAGE} and paste it again.`,
  'invalid-key': `This key was rejected by Google. Create a new key at ${KEY_PAGE} and paste it again.`,
  forbidden: `This key is not allowed to use the Gemini API. Check the project's API access at ${BILLING_PAGE}, or create a key under a different project at ${KEY_PAGE}.`,
  model: `This key cannot use the voice model. Check the project has access to the Gemini TTS models at ${BILLING_PAGE}, or pick another model in Daily Drop settings.`,
  'rate-limited': 'Google is rate-limiting this key right now. Wait a minute and check the key again.',
  network: 'Could not reach Google. Check your internet connection and check the key again.',
  unknown: `Google returned an unexpected error. Check the project at ${BILLING_PAGE}, then check the key again.`,
};

function parseGeminiError(status, text) {
  let message = String(text || '').slice(0, 400);
  let reason = '';
  try {
    const json = JSON.parse(text);
    const err = (Array.isArray(json) ? json[0] : json) || {};
    if (err.error) { message = err.error.message || message; reason = err.error.status || ''; }
  } catch { /* not JSON */ }
  return { message, reason };
}

function classify(status, { message, reason }) {
  if (status === 402 || /prepayment|billing/i.test(message)) return 'billing';
  if (status === 400 && /api key/i.test(message)) return 'invalid-key';
  if (status === 401 || status === 403 || reason === 'PERMISSION_DENIED') return /api key/i.test(message) ? 'invalid-key' : 'forbidden';
  if (status === 404 || (reason === 'NOT_FOUND' && /model/i.test(message))) return 'model';
  if (status === 429) return 'rate-limited';
  return 'unknown';
}

function result(code, message, extra = {}) {
  return { verified: code === 'ok', code, message, remediation: code === 'ok' ? '' : REMEDIATION[code], checkedAt: new Date().toISOString(), ...extra };
}

async function verifyApiKey({ apiKey, model, hosts, fetchFn = fetch }) {
  if (!apiKey) return result('no-key', 'No Gemini API key is saved.');
  const probe = { lines: [{ speaker: hosts[0].name, text: PROBE_TEXT }], pauseAfter: 0 };
  let res;
  try {
    res = await fetchFn(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(requestBody(probe, { model, hosts })),
    });
  } catch (e) {
    return result('network', e.message);
  }
  const text = await res.text();
  if (!res.ok) {
    const parsed = parseGeminiError(res.status, text);
    return result(classify(res.status, parsed), parsed.message, { status: res.status });
  }
  let pcm = null;
  try { pcm = extractAudio(JSON.parse(text)); } catch { /* fall through */ }
  if (!pcm || !pcm.length) return result('unknown', 'Google accepted the key but returned no audio.');
  return result('ok', `Voices ready with ${model}.`, { model });
}

module.exports = { verifyApiKey, REMEDIATION, PROBE_TEXT };
