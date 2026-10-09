const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const revision = value => sha(JSON.stringify(value));
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value : '';
const validUrl = value => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? value : null;
  } catch { return null; }
};

function readJson(file) {
  if (!file) return { state: 'not_configured' };
  try {
    return { state: 'ready', value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}

function sourceLinks(brief, queue) {
  const values = [brief?.sourceUrl, queue?.sourceUrl, queue?.emailSourceUrl,
    queue?.invitationSourceUrl, queue?.relatedRoleUrl,
    ...(Array.isArray(queue?.relatedThreadIds) ? queue.relatedThreadIds : [])];
  return [...new Set(values.map(validUrl).filter(Boolean))];
}

function canonicalJobKey(item) {
  const urlValue = validUrl(item.sourceUrl);
  if (!urlValue) return null;
  const url = new URL(urlValue);
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|gh_src$|source$|ref$|trk$|tracking)/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  const normalize = value => text(value).trim().toLowerCase().replace(/\s+/g, ' ');
  return `${url.href}|${normalize(item.company)}|${normalize(item.title)}`;
}

function briefCard(item, q) {
  return {
    id: item.id,
    kind: item.kind === 'recruiter' ? 'recruiter' : 'job',
    title: text(item.title), company: text(item.company), location: text(item.location),
    summary: text(item.summary), fit: text(item.fit), concern: text(item.concern),
    nextAction: text(item.nextAction), availability: text(item.availability),
    checkedAt: text(item.checkedAt) || null,
    sourceLinks: sourceLinks(item, q),
    schedulingUrl: validUrl(q?.schedulingUrl) || validUrl(item.schedulingUrl),
    draftReply: typeof q?.draftReply === 'string' ? q.draftReply : text(item.draftReply),
    status: text(q?.status) || null,
    nextReminderAt: text(q?.nextReminderAt) || null,
    sentAt: text(q?.sentAt) || null,
    lastInboundAt: text(q?.lastInboundAt || q?.lastInboundDate) || null,
    revision: q ? revision(q) : null,
    editable: Boolean(q),
    sourceAccount: text(item.sourceAccount) || null,
    relatedIds: [item.id],
    queueOnly: false,
  };
}

function queueOnlyCard(q) {
  return {
    id: q.id, kind: 'recruiter', title: text(q.title) || 'Recruiter outreach',
    company: text(q.company), location: '', summary: text(q.reason), fit: '', concern: '',
    nextAction: 'Review the original conversation before acting.', availability: '',
    checkedAt: text(q.lastReviewedAt || q.verifiedAt || q.sourceCheckAttemptedAt) || null,
    sourceLinks: sourceLinks(null, q), schedulingUrl: validUrl(q.schedulingUrl),
    draftReply: text(q.draftReply), status: text(q.status) || null,
    nextReminderAt: text(q.nextReminderAt) || null, sentAt: text(q.sentAt) || null,
    lastInboundAt: text(q.lastInboundAt || q.lastInboundDate) || null,
    revision: revision(q), editable: true, sourceAccount: null,
    relatedIds: [q.id], queueOnly: true,
  };
}

function findQueueRecord(queue, id) {
  for (const group of ['items', 'holds']) {
    if (!Array.isArray(queue[group])) continue;
    const index = queue[group].findIndex(item => item?.id === id);
    if (index !== -1) return { group, index, item: queue[group][index] };
  }
  return null;
}

function snapshot(briefResult, queueResult, accountsResult) {
  const briefValid = briefResult.state !== 'ready' || (isObject(briefResult.value)
    && Array.isArray(briefResult.value.sources) && Array.isArray(briefResult.value.opportunities));
  const queueValid = queueResult.state !== 'ready' || (isObject(queueResult.value)
    && Array.isArray(queueResult.value.items) && Array.isArray(queueResult.value.holds));
  const brief = briefValid ? briefResult.value : null;
  const queue = queueValid ? queueResult.value : null;
  const accounts = accountsResult.value;
  const opportunities = Array.isArray(brief?.opportunities) ? brief.opportunities : [];
  const unique = new Map();
  const canonical = new Map();
  const representedIds = new Set();
  for (const item of opportunities) {
    if (!isObject(item) || typeof item.id !== 'string') continue;
    const record = isObject(queue) ? findQueueRecord(queue, item.id) : null;
    const q = record?.item;
    const card = briefCard(item, q);
    const jobKey = card.kind === 'job' ? canonicalJobKey(item) : null;
    const key = canonical.get(jobKey) || item.id;
    representedIds.add(item.id);
    if (!unique.has(key)) {
      unique.set(key, card);
      if (jobKey) canonical.set(jobKey, key);
      continue;
    }
    const previous = unique.get(key);
    const preferred = card.editable && !previous.editable ? card
      : (!previous.editable && (card.checkedAt || '') > (previous.checkedAt || '') ? card : previous);
    unique.set(key, {
      ...preferred,
      sourceLinks: [...new Set([...previous.sourceLinks, ...card.sourceLinks])],
      relatedIds: [...new Set([...previous.relatedIds, ...card.relatedIds])],
    });
  }
  if (isObject(queue)) {
    for (const q of [...queue.items, ...queue.holds]) {
      if (!isObject(q) || typeof q.id !== 'string' || representedIds.has(q.id) || unique.has(q.id)) continue;
      unique.set(q.id, queueOnlyCard(q));
    }
  }
  return {
    briefState: briefValid ? briefResult.state : 'unreadable',
    queueState: queueValid ? queueResult.state : 'unreadable',
    generatedAt: text(brief?.generatedAt) || null,
    summary: text(brief?.summary),
    sources: Array.isArray(brief?.sources) ? brief.sources.filter(isObject).map(s => ({
      name: text(s.name), status: text(s.status), checkedAt: text(s.checkedAt), detail: text(s.detail),
      accountId: text(s.accountId) || null,
    })) : [],
    coverage: {
      recruiter: typeof queue?.coverage === 'string' ? queue.coverage : null,
      backfill: isObject(queue?.backfillCheckpoint) ? {
        updatedAt: queue.backfillCheckpoint.updatedAt || null,
        detail: queue.backfillCheckpoint.detail || null,
      } : null,
      invitations: isObject(queue?.invitationCoverage) ? {
        checkedAt: queue.invitationCoverage.checkedAt || null,
        detail: queue.invitationCoverage.detail || null,
      } : null,
    },
    accounts: Array.isArray(accounts?.accounts) ? accounts.accounts : [],
    accountsRevision: revision(accounts || { accounts: [] }),
    opportunities: [...unique.values()],
  };
}

function writeAtomic(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function editQueueItem(item, input, now) {
  const next = { ...item };
  if (input.action === 'draft') {
    if (typeof input.draftReply !== 'string' || input.draftReply.length > 4000) throw Error('Invalid draft.');
    next.draftReply = input.draftReply;
  } else if (input.action === 'snooze') {
    const date = Date.parse(input.until);
    if (typeof input.until !== 'string' || !Number.isFinite(date) || date <= Date.parse(now)) throw Error('Choose a future reminder time.');
    next.status = 'snoozed';
    next.nextReminderAt = new Date(date).toISOString();
  } else if (input.action === 'hold') {
    next.status = 'hold_user';
  } else if (input.action === 'skip') {
    next.status = 'declined';
    next.nextReminderAt = null;
  } else if (input.action === 'reopen') {
    next.status = 'ready_for_review';
  } else if (input.action === 'sent') {
    if (item.sentAt || item.status === 'meeting_booked') throw Error('This item is already sent or booked.');
    next.status = 'awaiting_recruiter';
    next.sentAt = now;
    next.nextReminderAt = null;
    next.verifiedAt = now;
    next.verification = 'user_reported';
    next.userReportedReplyStatus = 'sent';
    next.userReportedReplyStatusAt = now;
  } else {
    throw Error('Unknown action.');
  }
  return next;
}

function registerOpportunityRoutes(app, { dataDir, briefPath, queuePath }) {
  const accountsPath = path.join(dataDir, 'opportunity-accounts.json');

  app.get('/api/opportunities', (_req, res) => {
    res.json(snapshot(readJson(briefPath), readJson(queuePath), readJson(accountsPath)));
  });

  app.patch('/api/opportunities/:id', (req, res) => {
    if (!queuePath) return res.status(503).json({ error: 'Reply queue is not configured.' });
    const input = req.body;
    if (!isObject(input) || typeof input.revision !== 'string') return res.status(400).json({ error: 'A record revision is required.' });
    const read = readJson(queuePath);
    if (read.state !== 'ready' || !isObject(read.value)) return res.status(503).json({ error: 'Reply queue is unavailable.' });
    const queue = read.value;
    const found = findQueueRecord(queue, req.params.id);
    if (!found) return res.status(404).json({ error: 'Queue item was not found.' });
    if (revision(found.item) !== input.revision) return res.status(409).json({ error: 'This item changed. Refresh before editing.' });
    let next;
    try {
      next = editQueueItem(found.item, input, new Date().toISOString());
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    try {
      queue[found.group][found.index] = next;
      queue.updatedAt = new Date().toISOString();
      writeAtomic(queuePath, queue);
      res.json({ item: {
        id: next.id, status: next.status, draftReply: next.draftReply || '',
        nextReminderAt: next.nextReminderAt || null, sentAt: next.sentAt || null,
        revision: revision(next),
      } });
    } catch (error) {
      res.status(500).json({ error: 'Could not save the reply queue.' });
    }
  });

  app.put('/api/opportunities/accounts', (req, res) => {
    const input = req.body;
    if (!isObject(input) || !Array.isArray(input.accounts) || typeof input.revision !== 'string' || input.accounts.length > 12)
      return res.status(400).json({ error: 'Invalid account selection.' });
    const currentRead = readJson(accountsPath);
    if (currentRead.state === 'unreadable') return res.status(503).json({ error: 'Account selection is unreadable.' });
    const current = currentRead.value || { accounts: [] };
    if (revision(current) !== input.revision) return res.status(409).json({ error: 'Account selection changed. Refresh before editing.' });
    const accounts = input.accounts.map(account => ({
      id: account.id, kind: account.kind, label: account.label,
      accessStatus: account.accessStatus || 'unverified',
      accessCheckedAt: account.accessCheckedAt || null,
      accessDetail: account.accessDetail || '',
      sourceName: account.sourceName || '',
    }));
    if (accounts.some(a => !/^[a-zA-Z0-9_-]{1,80}$/.test(a.id || '') || !['gmail', 'linkedin_email', 'linkedin'].includes(a.kind)
      || typeof a.label !== 'string' || !a.label.trim() || a.label.length > 150
      || !['unverified', 'verified', 'blocked'].includes(a.accessStatus)
      || (a.accessCheckedAt !== null && (typeof a.accessCheckedAt !== 'string' || !Number.isFinite(Date.parse(a.accessCheckedAt))))
      || (a.accessStatus !== 'unverified' && !a.accessCheckedAt)
      || typeof a.accessDetail !== 'string' || a.accessDetail.length > 300
      || typeof a.sourceName !== 'string' || a.sourceName.length > 100)
      || new Set(accounts.map(a => a.id)).size !== accounts.length
      || new Set(accounts.map(a => `${a.kind}|${a.label.trim().toLowerCase()}`)).size !== accounts.length
      || new Set(accounts.filter(a => a.sourceName).map(a => `${a.kind}|${a.sourceName}`)).size !== accounts.filter(a => a.sourceName).length)
      return res.status(400).json({ error: 'Invalid account entry.' });
    const saved = { accounts };
    writeAtomic(accountsPath, saved);
    res.json({ accounts, revision: revision(saved) });
  });
}

module.exports = { registerOpportunityRoutes, snapshot, editQueueItem, revision };
