// app/lib/workbook/diagram.js
// Box-and-arrow diagrams for workbook chapters, written as a fenced ```diagram block.
// Runs in Node (lint, PDF export) and in the browser (the workbook viewer inlines this file).
//
//   ```diagram
//   title: The job scheduler
//   box api "Job API service" "validates and saves jobs" kind=service at=1,0
//   box db "Jobs database" "Postgres" kind=store at=1,1
//   arrow api -> db "insert row"
//   arrow workers <-> db "claim and finish"
//   ```
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WBDiagram = api;
}(typeof self !== 'undefined' ? self : this, function () {
  const KINDS = {
    client: ['#F2F2F2', '#7a7a7a', 'a user or caller'],
    service: ['#E3EDF8', '#1F4E79', 'a program we run'],
    store: ['#FFF3CC', '#9a7b10', 'where data is stored'],
    external: ['#EFE6F7', '#5B3A8C', "someone else's service"],
    job: ['#E6F4EA', '#2e7d32', 'a background job'],
  };
  const MAX_COLS = 4;
  const MAX_ROWS = 6;
  const CELL_W = 270;
  const CELL_H = 140;
  const BOX_W = 190;
  const BOX_H = 64;
  const LIMITS = { title: 28, sub: 36, label: 26, caption: 140 };

  function tokens(line) {
    const out = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(line))) out.push(m[1] !== undefined ? { q: true, v: m[1] } : { q: false, v: m[2] });
    return out;
  }

  function parseDiagram(text) {
    const errors = [];
    const boxes = [];
    const arrows = [];
    const ids = new Map();
    const cells = new Map();
    let title = '';
    String(text || '').replace(/\r/g, '').split('\n').forEach((raw, i) => {
      const line = raw.trim();
      const n = i + 1;
      if (!line || line.startsWith('#')) return;
      if (/^title:/.test(line)) {
        title = line.slice(6).trim();
        if (title.length > LIMITS.caption) errors.push(`line ${n}: title is longer than ${LIMITS.caption} characters`);
        return;
      }
      const t = tokens(line);
      if (t[0].v === 'box') {
        const id = t[1] && !t[1].q ? t[1].v : '';
        const label = t[2] && t[2].q ? t[2].v : null;
        const sub = t[3] && t[3].q ? t[3].v : '';
        const opts = {};
        for (const tok of t.slice(t[3] && t[3].q ? 4 : 3)) {
          const kv = tok.v.match(/^(kind|at)=(.+)$/);
          if (!kv || tok.q) { errors.push(`line ${n}: unexpected "${tok.v}" (box lines are: box id "Title" "optional subtitle" kind=service at=col,row)`); continue; }
          opts[kv[1]] = kv[2];
        }
        if (!/^[a-z][a-z0-9_-]*$/i.test(id)) { errors.push(`line ${n}: a box needs an id made of letters, digits, - or _`); return; }
        if (ids.has(id)) { errors.push(`line ${n}: box id "${id}" is used twice`); return; }
        if (label === null || !label.trim()) { errors.push(`line ${n}: box "${id}" needs a quoted title`); return; }
        if (label.length > LIMITS.title) errors.push(`line ${n}: box "${id}" title is over ${LIMITS.title} characters; shorten it`);
        if (sub.length > LIMITS.sub) errors.push(`line ${n}: box "${id}" subtitle is over ${LIMITS.sub} characters; shorten it`);
        const kind = opts.kind || 'service';
        if (!KINDS[kind]) errors.push(`line ${n}: kind must be one of ${Object.keys(KINDS).join(', ')}`);
        const at = String(opts.at || '').match(/^(\d+),(\d+)$/);
        if (!at) { errors.push(`line ${n}: box "${id}" needs at=col,row (for example at=0,1)`); return; }
        const col = Number(at[1]);
        const row = Number(at[2]);
        if (col >= MAX_COLS || row >= MAX_ROWS) errors.push(`line ${n}: at=${col},${row} is outside the grid (columns 0 to ${MAX_COLS - 1}, rows 0 to ${MAX_ROWS - 1})`);
        const cell = `${col},${row}`;
        if (cells.has(cell)) errors.push(`line ${n}: box "${id}" is in the same spot as "${cells.get(cell)}"`);
        cells.set(cell, id);
        const box = { id, label, sub, kind: KINDS[kind] ? kind : 'service', col, row };
        ids.set(id, box);
        boxes.push(box);
        return;
      }
      if (t[0].v === 'arrow') {
        const from = t[1] && t[1].v;
        const dir = t[2] && t[2].v;
        const to = t[3] && t[3].v;
        const label = t[4] && t[4].q ? t[4].v : '';
        if (!from || !to || !['->', '<->'].includes(dir) || t.length > 5 || (t[4] && !t[4].q)) {
          errors.push(`line ${n}: arrow lines are: arrow fromId -> toId "optional label" (or <-> for both ways)`);
          return;
        }
        if (label.length > LIMITS.label) errors.push(`line ${n}: arrow label is over ${LIMITS.label} characters; shorten it`);
        arrows.push({ from, to, both: dir === '<->', label, line: n });
        return;
      }
      errors.push(`line ${n}: lines start with "title:", "box" or "arrow"`);
    });
    for (const a of arrows) {
      for (const end of [a.from, a.to]) if (!ids.has(end)) errors.push(`line ${a.line}: arrow uses unknown box "${end}"`);
      if (a.from === a.to) errors.push(`line ${a.line}: an arrow must join two different boxes`);
    }
    if (boxes.length < 2) errors.push('a diagram needs at least two boxes');
    return { title, boxes, arrows, errors };
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function edge(b, tx, ty) {
    const cx = b.x + BOX_W / 2;
    const cy = b.y + BOX_H / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    if (!dx && !dy) return [cx, cy];
    const t = Math.min(dx ? (BOX_W / 2) / Math.abs(dx) : Infinity, dy ? (BOX_H / 2) / Math.abs(dy) : Infinity);
    return [cx + dx * t, cy + dy * t];
  }

  function wrapLabel(label) {
    if (label.length <= 14) return [label];
    const words = label.split(' ');
    const half = label.length / 2;
    let a = '';
    while (words.length && (a + ' ' + words[0]).trim().length <= half + 4) a = (a + ' ' + words.shift()).trim();
    return words.length ? [a, words.join(' ')] : [a];
  }

  function renderDiagram(spec, opts) {
    const parsed = typeof spec === 'string' ? parseDiagram(spec) : spec;
    if (parsed.errors && parsed.errors.length) {
      return `<pre class="diagram-error">Diagram could not be drawn:\n${esc(parsed.errors.join('\n'))}</pre>`;
    }
    const cols = Math.max(...parsed.boxes.map((b) => b.col)) + 1;
    const rows = Math.max(...parsed.boxes.map((b) => b.row)) + 1;
    const width = cols * CELL_W;
    const height = rows * CELL_H;
    const B = new Map(parsed.boxes.map((b) => [b.id, { ...b, x: b.col * CELL_W + (CELL_W - BOX_W) / 2, y: b.row * CELL_H + (CELL_H - BOX_H) / 2 }]));
    const parts = [`<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" font-family="Helvetica, Arial, sans-serif" role="img" aria-label="${esc(parsed.title || 'diagram')}">`,
      '<defs><marker id="wbarr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#444"/></marker></defs>'];
    const labels = [];
    for (const a of parsed.arrows) {
      const s = B.get(a.from);
      const d = B.get(a.to);
      const [sx, sy] = edge(s, d.x + BOX_W / 2, d.y + BOX_H / 2);
      const [ex, ey] = edge(d, s.x + BOX_W / 2, s.y + BOX_H / 2);
      parts.push(`<line x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="#444" stroke-width="1.6" marker-end="url(#wbarr)"${a.both ? ' marker-start="url(#wbarr)"' : ''}/>`);
      if (a.label) {
        const lines = wrapLabel(a.label);
        const w = Math.max(...lines.map((l) => l.length)) * 6.2 + 10;
        const h = lines.length * 13 + 5;
        let mx = (sx + ex) / 2;
        let my = (sy + ey) / 2;
        if (Math.abs(ey - sy) < 1) my -= h / 2 + 3;          // flat arrow: label sits above the line
        else if (Math.abs(ex - sx) < 1) mx += w / 2 + 5;     // upright arrow: label sits beside it
        labels.push(`<rect x="${(mx - w / 2).toFixed(1)}" y="${(my - h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="3" fill="#fff" opacity="0.94"/>`);
        lines.forEach((l, i) => labels.push(`<text x="${mx.toFixed(1)}" y="${(my - h / 2 + 13 + i * 13).toFixed(1)}" font-size="11" text-anchor="middle" fill="#333">${esc(l)}</text>`));
      }
    }
    for (const b of B.values()) {
      const [fill, stroke] = KINDS[b.kind];
      parts.push(`<rect x="${b.x}" y="${b.y}" width="${BOX_W}" height="${BOX_H}" rx="7" fill="${fill}" stroke="${stroke}" stroke-width="1.6"/>`);
      const cx = b.x + BOX_W / 2;
      const top = b.sub ? b.y + BOX_H / 2 - 4 : b.y + BOX_H / 2 + 5;
      parts.push(`<text x="${cx}" y="${top}" font-size="13" font-weight="bold" text-anchor="middle" fill="#1b1b1b">${esc(b.label)}</text>`);
      if (b.sub) parts.push(`<text x="${cx}" y="${top + 17}" font-size="11" text-anchor="middle" fill="#333">${esc(b.sub)}</text>`);
    }
    parts.push(...labels, '</svg>');
    const used = [...new Set(parsed.boxes.map((b) => b.kind))];
    const legend = (opts && opts.legend === false) ? '' : `<p class="diagram-legend">${used.map((k) => `<span style="background:${KINDS[k][0]};border:1px solid ${KINDS[k][1]};border-radius:3px;padding:1px 6px;margin-right:4px;font-size:0.8em">${esc(KINDS[k][2])}</span>`).join(' ')}</p>`;
    const cap = parsed.title ? `<figcaption>${esc(parsed.title)}</figcaption>` : '';
    return `<figure class="diagram">${legend}${parts.join('')}${cap}</figure>`;
  }

  return { parseDiagram, renderDiagram, KINDS: Object.keys(KINDS) };
}));
