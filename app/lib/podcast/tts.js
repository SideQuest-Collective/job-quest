// app/lib/podcast/tts.js
// Gemini multi-speaker TTS (Interactions API) -> 24 kHz mono PCM -> one audio file.
// The script is cut into chunks at each pause beat; real silence is inserted between them.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const RATE = 24000;
const MAX_CHUNK_CHARS = 2800;

function chunkSegments(segments) {
  const chunks = [];
  let cur = { lines: [], chars: 0, pauseAfter: 0 };
  const flush = (pause) => {
    if (cur.lines.length) { cur.pauseAfter = pause; chunks.push(cur); }
    else if (pause && chunks.length) chunks[chunks.length - 1].pauseAfter += pause;
    cur = { lines: [], chars: 0, pauseAfter: 0 };
  };
  for (const s of segments) {
    if (s.type === 'pause') { flush(s.seconds); continue; }
    if (cur.chars + s.text.length > MAX_CHUNK_CHARS && cur.lines.length) flush(0);
    cur.lines.push(s);
    cur.chars += s.text.length;
  }
  flush(0);
  return chunks;
}

function requestBody(chunk, { model, hosts }) {
  return {
    model,
    input: [{
      type: 'user_input',
      content: chunk.lines.map((l) => ({
        type: 'text',
        text: l.text,
        annotations: [{ type: 'speech_metadata', speaker: l.speaker, ...(l.style ? { style: l.style } : {}) }],
      })),
    }],
    response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: RATE },
    generation_config: {
      speech_config: { mode: 'conversational', speakers: hosts.map((h) => ({ speaker: h.name, voice: h.voice })) },
    },
  };
}

// Find base64 audio anywhere in the response (steps[].content[] in the Interactions API).
function extractAudio(json) {
  const found = [];
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if ((v.type === 'audio' || /^audio\//.test(v.mime_type || v.mimeType || '')) && typeof v.data === 'string') { found.push(v.data); return; }
    if (v.inlineData && typeof v.inlineData.data === 'string') { found.push(v.inlineData.data); return; }
    Object.values(v).forEach(walk);
  };
  walk(json);
  if (!found.length) return null;
  return stripWavHeader(Buffer.concat(found.map((d) => Buffer.from(d, 'base64'))));
}

function stripWavHeader(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return buf;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size;
  }
  return buf.subarray(44);
}

const silence = (seconds) => Buffer.alloc(Math.round(seconds * RATE) * 2);

function wavHeader(dataLen) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataLen, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(dataLen, 40);
  return h;
}

async function synthesizeChunk(chunk, { apiKey, model, hosts, fetchFn = fetch, retries = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetchFn(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(requestBody(chunk, { model, hosts })),
      });
      const text = await res.text();
      if (!res.ok) {
        lastErr = new Error(`Gemini TTS ${res.status}: ${text.slice(0, 300)}`);
        if (res.status === 429 || res.status >= 500) { await sleep(2000 * (i + 1) ** 2); continue; }
        throw lastErr;
      }
      const pcm = extractAudio(JSON.parse(text));
      if (!pcm || !pcm.length) throw new Error('Gemini TTS returned no audio');
      return pcm;
    } catch (e) {
      lastErr = e;
      if (/ 4\d\d:/.test(e.message) && !/ 429:/.test(e.message)) throw e;
      await sleep(2000 * (i + 1));
    }
  }
  throw lastErr;
}

// Encode to the smallest format available: mp3 (ffmpeg) -> m4a (macOS afconvert) -> wav.
function encode(wavPath, outBase) {
  const has = (cmd) => spawnSync('bash', ['-lc', `command -v ${cmd}`]).status === 0;
  if (has('ffmpeg')) {
    const mp3 = `${outBase}.mp3`;
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wavPath, '-ac', '1', '-b:a', '64k', mp3]);
    if (r.status === 0) { fs.rmSync(wavPath, { force: true }); return mp3; }
  }
  if (has('afconvert')) {
    const m4a = `${outBase}.m4a`;
    const r = spawnSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '64000', wavPath, m4a]);
    if (r.status === 0) { fs.rmSync(wavPath, { force: true }); return m4a; }
  }
  return wavPath;
}

async function renderEpisodeAudio({ script, outDir, apiKey, model, hosts, fetchFn, onProgress = () => {} }) {
  if (!apiKey) throw Object.assign(new Error('No Gemini API key. Add one on the Daily Drop page.'), { code: 'no-key' });
  const chunks = chunkSegments(script.segments);
  const parts = [silence(0.4)];
  for (let i = 0; i < chunks.length; i++) {
    onProgress(i, chunks.length);
    parts.push(await synthesizeChunk(chunks[i], { apiKey, model, hosts, fetchFn }));
    parts.push(silence(chunks[i].pauseAfter || 0.25));
  }
  const pcm = Buffer.concat(parts);
  fs.mkdirSync(outDir, { recursive: true });
  const wavPath = path.join(outDir, 'episode.wav');
  fs.writeFileSync(wavPath, Buffer.concat([wavHeader(pcm.length), pcm]));
  const file = encode(wavPath, path.join(outDir, 'episode'));
  return { file: path.basename(file), seconds: Math.round(pcm.length / 2 / RATE), chunks: chunks.length };
}

module.exports = { ENDPOINT, RATE, chunkSegments, requestBody, extractAudio, stripWavHeader, synthesizeChunk, renderEpisodeAudio, wavHeader };
