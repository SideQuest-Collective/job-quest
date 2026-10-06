// app/lib/resume/pyliteral.js
// Restricted evaluator for top-level Python assignments made of literals.
// Supported: str (', ", ''', """; r/u prefixes; implicit concatenation), int/float, True/False/None,
// list, tuple, dict literals, dict(k=v, ...) and dict(<dict>) (shallow copy), names bound by
// earlier assignments, subscripts NAME[k][k2], and assignments NAME = v / NAME[k]... = v.
// Anything else raises PyLiteralError. Nothing is executed.

class PyLiteralError extends Error {}

const NAME_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
const NUM_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const STR_START = /^([rRuU]?)('''|"""|'|")/;
const STMT_START = /^([A-Za-z_][A-Za-z0-9_]*)\s*[[=](?!=)/;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

class Lexer {
  constructor(src, pos = 0) {
    this.src = src;
    this.pos = pos;
    this.depth = 0;
    this.peeked = null;
  }

  lineAt(pos) {
    let n = 1;
    for (let i = 0; i < pos && i < this.src.length; i++) if (this.src[i] === '\n') n++;
    return n;
  }

  fail(msg, pos = this.pos) {
    throw new PyLiteralError(`${msg} at line ${this.lineAt(pos)}`);
  }

  skipSpace() {
    for (;;) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t' || c === '\r') { this.pos++; continue; }
      if (c === '\\' && this.src[this.pos + 1] === '\n') { this.pos += 2; continue; }
      if (c === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++;
        continue;
      }
      if (c === '\n' && this.depth > 0) { this.pos++; continue; }
      return;
    }
  }

  peek() {
    if (!this.peeked) this.peeked = this.read();
    return this.peeked;
  }

  next() {
    const t = this.peek();
    this.peeked = null;
    return t;
  }

  isOp(value) {
    const t = this.peek();
    return t.type === 'op' && t.value === value;
  }

  save() { return { pos: this.pos, depth: this.depth, peeked: this.peeked }; }

  restore(s) { this.pos = s.pos; this.depth = s.depth; this.peeked = s.peeked; }

  read() {
    this.skipSpace();
    const start = this.pos;
    if (this.pos >= this.src.length) return { type: 'eof', pos: start };
    const c = this.src[this.pos];
    if (c === '\n') { this.pos++; return { type: 'newline', pos: start }; }
    const sm = STR_START.exec(this.src.slice(this.pos, this.pos + 4));
    if (sm) return this.readString(sm, start);
    NAME_RE.lastIndex = this.pos;
    const nm = NAME_RE.exec(this.src);
    if (nm) { this.pos += nm[0].length; return { type: 'name', value: nm[0], pos: start }; }
    if (/\d/.test(c) || (c === '-' && /\d/.test(this.src[this.pos + 1] || ''))) {
      NUM_RE.lastIndex = this.pos;
      const m = NUM_RE.exec(this.src);
      this.pos += m[0].length;
      return { type: 'num', value: Number(m[0]), pos: start };
    }
    if ('([{'.includes(c)) { this.depth++; this.pos++; return { type: 'op', value: c, pos: start }; }
    if (')]}'.includes(c)) { this.depth--; this.pos++; return { type: 'op', value: c, pos: start }; }
    if (',:='.includes(c)) { this.pos++; return { type: 'op', value: c, pos: start }; }
    return this.fail(`unsupported character ${JSON.stringify(c)}`, start);
  }

  readString(sm, start) {
    const raw = sm[1].toLowerCase() === 'r';
    const quote = sm[2];
    let i = this.pos + sm[0].length;
    let out = '';
    for (;;) {
      if (i >= this.src.length) this.fail('unterminated string', start);
      if (this.src.startsWith(quote, i)) { i += quote.length; break; }
      const ch = this.src[i];
      if (ch === '\n' && quote.length === 1) this.fail('unterminated string', start);
      if (ch === '\\') {
        const nx = this.src[i + 1];
        if (raw) { out += ch + (nx === undefined ? '' : nx); i += 2; continue; }
        i += 2;
        if (nx === 'n') out += '\n';
        else if (nx === 't') out += '\t';
        else if (nx === 'r') out += '\r';
        else if (nx === '\\') out += '\\';
        else if (nx === "'") out += "'";
        else if (nx === '"') out += '"';
        else if (nx === '\n') out += '';
        else if (nx === 'u') { out += String.fromCharCode(parseInt(this.src.slice(i, i + 4), 16)); i += 4; }
        else if (nx === 'x') { out += String.fromCharCode(parseInt(this.src.slice(i, i + 2), 16)); i += 2; }
        else out += `\\${nx}`;
        continue;
      }
      out += ch;
      i++;
    }
    this.pos = i;
    return { type: 'str', value: out, pos: start };
  }
}

function expectOp(lx, value) {
  const t = lx.next();
  if (t.type !== 'op' || t.value !== value) lx.fail(`expected "${value}"`, t.pos);
}

function index(lx, container, key, pos) {
  if (Array.isArray(container) && Number.isInteger(key)) {
    const i = key < 0 ? container.length + key : key;
    if (i >= 0 && i < container.length) return container[i];
  } else if (container && typeof container === 'object' && hasOwn(container, key)) {
    return container[key];
  }
  return lx.fail(`key ${JSON.stringify(key)} not found`, pos);
}

function parseSeq(lx, env, close, paren) {
  const items = [];
  let comma = false;
  for (;;) {
    if (lx.isOp(close)) { lx.next(); break; }
    items.push(parseExpr(lx, env));
    const n = lx.next();
    if (n.type === 'op' && n.value === ',') { comma = true; continue; }
    if (n.type === 'op' && n.value === close) break;
    lx.fail(`expected "," or "${close}"`, n.pos);
  }
  return paren && items.length === 1 && !comma ? items[0] : items;
}

function parseDict(lx, env) {
  const out = {};
  for (;;) {
    if (lx.isOp('}')) { lx.next(); return out; }
    const key = parseExpr(lx, env);
    expectOp(lx, ':');
    out[key] = parseExpr(lx, env);
    const n = lx.next();
    if (n.type === 'op' && n.value === ',') continue;
    if (n.type === 'op' && n.value === '}') return out;
    lx.fail('expected "," or "}"', n.pos);
  }
}

function parseDictCall(lx, env) {
  const out = {};
  for (;;) {
    if (lx.isOp(')')) { lx.next(); return out; }
    const saved = lx.save();
    const t = lx.next();
    if (t.type === 'name' && lx.isOp('=')) {
      lx.next();
      out[t.value] = parseExpr(lx, env);
    } else {
      lx.restore(saved);
      const v = parseExpr(lx, env);
      if (!v || typeof v !== 'object' || Array.isArray(v)) lx.fail('dict() positional argument must be a dict', t.pos);
      Object.assign(out, v);
    }
    const n = lx.next();
    if (n.type === 'op' && n.value === ',') continue;
    if (n.type === 'op' && n.value === ')') return out;
    lx.fail('expected "," or ")"', n.pos);
  }
}

function parseExpr(lx, env) {
  const t = lx.next();
  if (t.type === 'str') {
    let s = t.value;
    while (lx.peek().type === 'str') s += lx.next().value;
    return s;
  }
  if (t.type === 'num') return t.value;
  if (t.type === 'op' && t.value === '[') return parseSeq(lx, env, ']', false);
  if (t.type === 'op' && t.value === '(') return parseSeq(lx, env, ')', true);
  if (t.type === 'op' && t.value === '{') return parseDict(lx, env);
  if (t.type === 'name') {
    if (t.value === 'True') return true;
    if (t.value === 'False') return false;
    if (t.value === 'None') return null;
    if (t.value === 'dict' && lx.isOp('(')) { lx.next(); return parseDictCall(lx, env); }
    if (!hasOwn(env, t.value)) lx.fail(`unknown name ${t.value}`, t.pos);
    let v = env[t.value];
    while (lx.isOp('[')) {
      lx.next();
      const k = parseExpr(lx, env);
      expectOp(lx, ']');
      v = index(lx, v, k, t.pos);
    }
    return v;
  }
  return lx.fail(`unexpected ${t.type === 'op' ? JSON.stringify(t.value) : t.type}`, t.pos);
}

function parseStatement(lx, env) {
  const t = lx.next();
  if (t.type !== 'name') lx.fail('expected an assignment', t.pos);
  const keys = [];
  while (lx.isOp('[')) {
    lx.next();
    keys.push(parseExpr(lx, env));
    expectOp(lx, ']');
  }
  expectOp(lx, '=');
  const value = parseExpr(lx, env);
  const end = lx.next();
  if (end.type !== 'newline' && end.type !== 'eof') lx.fail('expected end of statement', end.pos);
  if (!keys.length) { env[t.value] = value; return; }
  if (!hasOwn(env, t.value)) lx.fail(`unknown name ${t.value}`, t.pos);
  let target = env[t.value];
  for (const k of keys.slice(0, -1)) target = index(lx, target, k, t.pos);
  if (!target || typeof target !== 'object') lx.fail('can only assign into a dict or list', t.pos);
  target[keys[keys.length - 1]] = value;
}

function parseAssignments(src, { only = null } = {}) {
  const text = String(src).replace(/\r\n/g, '\n');
  const env = {};
  let pos = 0;
  while (pos < text.length) {
    const eol = text.indexOf('\n', pos);
    const lineEnd = eol === -1 ? text.length : eol;
    const line = text.slice(pos, lineEnd);
    const m = STMT_START.exec(line);
    if (m && (!only || only.includes(m[1]))) {
      const lx = new Lexer(text, pos);
      parseStatement(lx, env);
      pos = lx.pos;
      continue;
    }
    if (!only && !/^\s*(#.*)?$/.test(line)) {
      throw new PyLiteralError(`unsupported statement at line ${text.slice(0, pos).split('\n').length}`);
    }
    pos = lineEnd + 1;
  }
  return env;
}

module.exports = { parseAssignments, PyLiteralError };
