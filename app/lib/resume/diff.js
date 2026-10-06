// app/lib/resume/diff.js
function diffOps(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ op: 'eq', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ op: 'del', text: a[i] }); i++; }
    else { ops.push({ op: 'add', text: b[j] }); j++; }
  }
  while (i < n) ops.push({ op: 'del', text: a[i++] });
  while (j < m) ops.push({ op: 'add', text: b[j++] });
  return ops;
}

function lineDiff(aText, bText, { context = 3 } = {}) {
  const ops = diffOps(String(aText).split('\n'), String(bText).split('\n'));
  if (ops.every((o) => o.op === 'eq')) return '(no changes)';
  const out = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].op !== 'eq') {
      out.push(`${ops[k].op === 'add' ? '+' : '-'} ${ops[k].text}`);
      k++;
      continue;
    }
    let e = k;
    while (e < ops.length && ops[e].op === 'eq') e++;
    const run = ops.slice(k, e);
    const head = k === 0 ? 0 : context;
    const tail = e === ops.length ? 0 : context;
    if (run.length > head + tail + 1) {
      run.slice(0, head).forEach((o) => out.push(`  ${o.text}`));
      out.push(`  … ${run.length - head - tail} unchanged lines`);
      run.slice(run.length - tail).forEach((o) => out.push(`  ${o.text}`));
    } else {
      run.forEach((o) => out.push(`  ${o.text}`));
    }
    k = e;
  }
  return out.join('\n');
}

function wordDiff(a, b) {
  const words = (s) => String(s || '').split(/\s+/).filter(Boolean);
  const merged = [];
  for (const o of diffOps(words(a), words(b))) {
    const last = merged[merged.length - 1];
    if (last && last.op === o.op) last.text += ` ${o.text}`;
    else merged.push({ ...o });
  }
  return merged;
}

function diffTailored(master, tailored) {
  const idx = new Map();
  for (const e of master.experience || []) for (const r of e.roles || []) for (const b of r.bullets || []) idx.set(b.id, b.text);
  for (const p of master.projects || []) for (const b of p.bullets || []) idx.set(b.id, b.text);
  const find = (list, id) => (Array.isArray(list) ? list : []).find((x) => x && x.id === id);
  const section = (masterBullets, tailoredBullets) => {
    const used = new Set();
    const items = (Array.isArray(tailoredBullets) ? tailoredBullets : []).filter(Boolean).map((b) => {
      const src = typeof b.src === 'string' && idx.has(b.src) ? idx.get(b.src) : null;
      if (b.src) used.add(b.src);
      const text = typeof b.text === 'string' ? b.text : '';
      return {
        src: b.src || null,
        master: src,
        tailored: text,
        status: src === null ? 'unknown-source' : src === text ? 'kept' : 'rewritten',
        ops: src === null ? [] : wordDiff(src, text),
      };
    });
    const dropped = (masterBullets || []).filter((b) => !used.has(b.id) && !b.variantOf).map((b) => ({ id: b.id, text: b.text }));
    return { items, dropped };
  };
  const t = tailored || {};
  return {
    experience: (master.experience || []).map((e) => {
      const te = find(t.experience, e.id);
      return {
        id: e.id,
        employer: e.employer,
        roles: (e.roles || []).map((r) => ({ id: r.id, title: r.title, ...section(r.bullets, (find(te && te.roles, r.id) || {}).bullets) })),
      };
    }),
    projects: (master.projects || []).map((p) => {
      const tp = find(t.projects, p.id);
      return { id: p.id, name: p.name, included: !!tp, ...section(p.bullets, tp && tp.bullets) };
    }),
  };
}

module.exports = { diffOps, lineDiff, wordDiff, diffTailored };
