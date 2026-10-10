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
  const values = [brief?.sourceUrl, brief?.emailSourceUrl, brief?.linkedinSourceUrl, brief?.invitationSourceUrl, queue?.sourceUrl, queue?.emailSourceUrl, queue?.linkedinSourceUrl,
    queue?.invitationSourceUrl, queue?.relatedRoleUrl,
    ...(Array.isArray(queue?.relatedThreadIds) ? queue.relatedThreadIds : []),
    ...(Array.isArray(brief?.sourceLinks) ? brief.sourceLinks : []),
    ...(Array.isArray(queue?.sourceLinks) ? queue.sourceLinks : [])];
  return [...new Set(values.map(validUrl).filter(Boolean))];
}

const normalizeIdentity = value => text(value).trim().toLowerCase().replace(/\s+/g, ' ');
function recruiterRecipient(record) {
  const recipient = text(record?.recipientEmail).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) && !/(?:@(?:[^@.]+\.)*linkedin\.com$|inmail|noreply|no-reply|notifications?@)/i.test(recipient) ? recipient : '';
}
function outreachMetadata(brief, queue) {
  const records = [brief, queue].filter(Boolean);
  const sourceProvenance = records.map(record => ({
    id: record.id,
    account: text(record.sourceAccount || record.accountId || record.account) || null,
    channel: text(record.channel) || null,
    links: sourceLinks(record, record),
  }));
  return {
    sourceAccount: sourceProvenance.find(source => source.account)?.account || null,
    sourceAccounts: [...new Set(sourceProvenance.map(source => source.account).filter(Boolean))],
    sourceProvenance,
    replyChannelSignals: records.map(record => Object.fromEntries(['channel', 'sourceUrl', 'emailSourceUrl', 'linkedinSourceUrl', 'recipientEmail', 'requestedReplyChannel', 'recruiterRequestedChannel', 'ongoingSubstantiveChannel', 'needsDocuments', 'needsResume', 'replyRequiresDocuments', 'responseType'].filter(key => record[key] !== undefined).map(key => [key, record[key]]))),
    outreachIdentity: {
      company: normalizeIdentity(brief?.company || queue?.company),
      role: normalizeIdentity(brief?.role || queue?.role || brief?.title || queue?.title),
      sender: normalizeIdentity(queue?.senderEmail || brief?.senderEmail || queue?.recruiterEmail || brief?.recruiterEmail || queue?.recruiter || brief?.recruiter || queue?.sender || brief?.sender || recruiterRecipient(queue) || recruiterRecipient(brief)),
      location: normalizeIdentity(brief?.location || queue?.location),
      conversationLinks: [...new Set(records.flatMap(record => [record.sourceUrl, record.emailSourceUrl, record.invitationSourceUrl, ...(Array.isArray(record.relatedThreadIds) ? record.relatedThreadIds : []), ...(Array.isArray(record.sourceLinks) ? record.sourceLinks : [])]).map(validUrl).filter(Boolean))],
    },
  };
}
function conversationUrl(value) {
  const valid = validUrl(value);
  if (!valid) return null;
  const url = new URL(valid);
  if ((url.pathname === '/' && !url.hash) || /(?:\/(?:inbox|messaging)\/?$|#(?:inbox|all|starred|important)?$)/i.test(valid)) return null;
  return valid;
}
function sameOutreach(a, b) {
  if (a.kind !== 'recruiter' || b.kind !== 'recruiter') return false;
  const x = a.outreachIdentity, y = b.outreachIdentity;
  if (!x || !y || !x.company || !x.role || !x.sender || x.company !== y.company || x.role !== y.role || x.sender !== y.sender) return false;
  if (x.location && y.location && x.location !== y.location) return false;
  return x.conversationLinks.some(link => conversationUrl(link) && y.conversationLinks.includes(link))
    || Boolean(a.schedulingUrl && a.schedulingUrl === b.schedulingUrl && x.location && x.location === y.location);
}
function mergeCards(a, b) {
  const preferred = b.editable && !a.editable ? b
    : (!a.editable && (b.checkedAt || '') > (a.checkedAt || '') ? b : a);
  const sourceAccounts = [...new Set([...(a.sourceAccounts || []), ...(b.sourceAccounts || [])])];
  return { ...preferred,
    sourceLinks: [...new Set([...a.sourceLinks, ...b.sourceLinks])],
    relatedIds: [...new Set([...a.relatedIds, ...b.relatedIds])],
    sourceAccount: preferred.sourceAccount || sourceAccounts[0] || null,
    schedulingUrl: preferred.schedulingUrl || a.schedulingUrl || b.schedulingUrl || null,
    relatedRoleUrl: preferred.relatedRoleUrl || a.relatedRoleUrl || b.relatedRoleUrl || null,
    sourceAccounts,
    replyChannelSignals: [...(a.replyChannelSignals || []), ...(b.replyChannelSignals || [])],
    outreachIdentity: { ...preferred.outreachIdentity, conversationLinks: [...new Set([...(a.outreachIdentity?.conversationLinks || []), ...(b.outreachIdentity?.conversationLinks || [])])] },
    sourceProvenance: [...(a.sourceProvenance || []), ...(b.sourceProvenance || [])],
  };
}
function reconcileOutreach(cards) {
  const result = [];
  for (const card of cards) {
    const previous = result.find(item => sameOutreach(item, card));
    if (!previous) { result.push(card); continue; }
    // Never combine independently editable queue records: a mutation must target
    // its own revision and cannot silently leave a second decision behind.
    const conflict = previous.editable && card.editable
      || Boolean(previous.draftReply && card.draftReply && previous.draftReply !== card.draftReply);
    if (conflict) {
      const reason = 'Matching outreach has separate saved drafts or decisions. Review both original records before reconciling.';
      previous.duplicateConflicts = [...(previous.duplicateConflicts || []), { id: card.id, reason }];
      card.duplicateConflicts = [{ id: previous.id, reason }];
      result.push(card);
    } else result[result.indexOf(previous)] = mergeCards(previous, card);
  }
  return result;
}

function replyChannelRecommendation(card) {
  const signals = card.replyChannelSignals || [];
  const channel = value => ['email', 'gmail'].includes(normalizeIdentity(value)) ? 'email'
    : normalizeIdentity(value) === 'linkedin' ? 'linkedin' : null;
  const choose = key => [...new Set(signals.map(s => channel(s[key])).filter(Boolean))];
  let recommendedReplyChannel = null;
  let replyChannelReason = 'Choose one reply channel after checking the original conversations.';
  const requested = [...new Set(signals.flatMap(s => [channel(s.requestedReplyChannel), channel(s.recruiterRequestedChannel)]).filter(Boolean))];
  const ongoing = choose('ongoingSubstantiveChannel');
  const urls = { email: null, linkedin: null };
  const sources = new Map();
  const urlChannel = value => {
    if (!validUrl(value)) return null;
    const host = new URL(value).hostname;
    return /(^|\.)linkedin\.com$/i.test(host) ? 'linkedin' : host === 'mail.google.com' ? 'email' : null;
  };
  const addSource = (kind, value, canReply) => {
    const url = validUrl(value);
    if (!url || !kind) return;
    const previous = sources.get(url);
    const reply = Boolean(canReply || previous?.canReply);
    sources.set(url, { channel: kind, url, canReply: reply });
    if (reply && !urls[kind]) urls[kind] = url;
  };
  for (const signal of signals) {
    const notification = normalizeIdentity(signal.channel) === 'linkedin_email';
    addSource('email', signal.emailSourceUrl, !notification);
    addSource('linkedin', signal.linkedinSourceUrl, true);
    const knownChannel = urlChannel(signal.sourceUrl) || channel(signal.channel);
    addSource(knownChannel, signal.sourceUrl, knownChannel === 'linkedin' || (knownChannel === 'email' && !notification && (channel(signal.channel) === 'email' || Boolean(recruiterRecipient(signal)))));
  }
  for (const url of card.sourceLinks || []) {
    const knownChannel = urlChannel(url);
    addSource(knownChannel, url, knownChannel === 'linkedin');
  }
  const draft = text(card.draftReply).trim();
  const draftDocuments = /\b(?:resume|résumé|cv|attachments?|attached|documents?|portfolio)\b/i.test(draft);
  const briefDraft = Boolean(draft && draft.length <= 300 && !draftDocuments);
  if (requested.length > 1 || (!requested.length && ongoing.length > 1)) {
    replyChannelReason = 'Stored channel preferences conflict. Check the original conversations and choose one channel.';
  } else if (requested.length === 1) {
    recommendedReplyChannel = requested[0]; replyChannelReason = 'The recruiter explicitly requested this reply channel.';
  } else if (ongoing.length === 1) {
    recommendedReplyChannel = ongoing[0]; replyChannelReason = 'Continue the ongoing substantive conversation in this channel.';
  } else if (signals.some(s => s.needsDocuments === true || s.needsResume === true || s.replyRequiresDocuments === true || ['detailed', 'resume', 'documents'].includes(normalizeIdentity(s.responseType)))) {
    recommendedReplyChannel = 'email'; replyChannelReason = 'Email is preferred for the recorded document or detailed-response need.';
  } else if (signals.some(s => ['quick', 'acknowledgement', 'scheduled-time'].includes(normalizeIdentity(s.responseType))) && urls.linkedin) {
    recommendedReplyChannel = 'linkedin'; replyChannelReason = 'Use the LinkedIn outreach for this recorded quick acknowledgement or scheduled-time reply.';
  } else if (draftDocuments && urls.email) {
    recommendedReplyChannel = 'email'; replyChannelReason = 'Email suits this draft’s document references. Check the original ask before sending.';
  } else if (draft.length > 300 && urls.email) {
    recommendedReplyChannel = 'email'; replyChannelReason = 'Email suits this longer draft. Send one reply in your chosen channel.';
  } else if (briefDraft && urls.linkedin) {
    recommendedReplyChannel = 'linkedin'; replyChannelReason = 'LinkedIn suits this brief reply in the existing outreach. Send it once.';
  } else if (Boolean(urls.email) !== Boolean(urls.linkedin)) {
    recommendedReplyChannel = urls.email ? 'email' : 'linkedin'; replyChannelReason = `Use the saved ${urls.email ? 'email' : 'LinkedIn'} conversation; no other direct reply channel is saved.`;
  }
  return { ...card, replySources: [...sources.values()], recommendedReplyChannel, replyChannelReason,
    recommendedReplyUrl: recommendedReplyChannel ? urls[recommendedReplyChannel] : null };
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
    relatedRoleUrl: validUrl(q?.relatedRoleUrl) || validUrl(item.relatedRoleUrl),
    draftReply: typeof q?.draftReply === 'string' ? q.draftReply : text(item.draftReply),
    status: text(q?.status) || null,
    nextReminderAt: text(q?.nextReminderAt) || null,
    sentAt: text(q?.sentAt) || null,
    sentChannel: text(q?.sentChannel || q?.userReportedReplyChannel) || null,
    verification: text(q?.verification) || null,
    verifiedAt: text(q?.verifiedAt) || null,
    userReportedReplyStatus: text(q?.userReportedReplyStatus) || null,
    userReportedReplyStatusAt: text(q?.userReportedReplyStatusAt) || null,
    lastInboundAt: text(q?.lastInboundAt || q?.lastInboundDate) || null,
    revision: q ? revision(q) : null,
    editable: Boolean(q),
    ...outreachMetadata(item, q),
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
    relatedRoleUrl: validUrl(q.relatedRoleUrl),
    draftReply: text(q.draftReply), status: text(q.status) || null,
    nextReminderAt: text(q.nextReminderAt) || null, sentAt: text(q.sentAt) || null,
    sentChannel: text(q.sentChannel || q.userReportedReplyChannel) || null,
    verification: text(q.verification) || null,
    verifiedAt: text(q.verifiedAt) || null,
    userReportedReplyStatus: text(q.userReportedReplyStatus) || null,
    userReportedReplyStatusAt: text(q.userReportedReplyStatusAt) || null,
    lastInboundAt: text(q.lastInboundAt || q.lastInboundDate) || null,
    revision: revision(q), editable: true, ...outreachMetadata(null, q),
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
    unique.set(key, mergeCards(unique.get(key), card));
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
    opportunities: reconcileOutreach([...unique.values()]).map(replyChannelRecommendation),
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
  if (['snooze', 'hold', 'reopen'].includes(input.action) && (item.sentAt || item.status === 'meeting_booked')) throw Error('This conversation is already sent or booked. Initial-reply reminders stay stopped.');
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
    if (item.reminderResumeHistory !== undefined && !Array.isArray(item.reminderResumeHistory)) throw Error('Stored reminder history is unavailable. Review this record before resuming.');
    next.reminderResumeHistory = [...(item.reminderResumeHistory || []), {
      resumedAt: now, previousStatus: item.status || null,
      nextReminderAt: item.nextReminderAt || null,
      reminderCount: item.reminderCount ?? 0,
      lastNudgedAt: item.lastNudgedAt || null,
    }];
    next.status = 'ready_for_review';
    next.nextReminderAt = null;
    next.reminderCount = 0;
    next.lastNudgedAt = null;
    next.reviewResumedAt = now;
  } else if (input.action === 'sent') {
    if (item.sentAt || item.status === 'meeting_booked') throw Error('This item is already sent or booked.');
    if (!['email', 'linkedin'].includes(input.sentChannel)) throw Error('Choose the channel you used to send the reply.');
    const sentAt = input.sentAt === undefined || input.sentAt === '' ? now : input.sentAt;
    if (typeof sentAt !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/i.test(sentAt) || !Number.isFinite(Date.parse(sentAt)) || Date.parse(sentAt) > Date.parse(now)) throw Error('Choose a valid sent time that is not in the future.');
    next.status = 'awaiting_recruiter';
    next.sentAt = new Date(sentAt).toISOString();
    next.sentChannel = input.sentChannel;
    next.nextReminderAt = null;
    next.verifiedAt = now;
    next.verification = 'user_reported';
    next.userReportedReplyStatus = 'sent';
    next.userReportedReplyChannel = input.sentChannel;
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
