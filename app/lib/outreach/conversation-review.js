const fs = require('node:fs');
const path = require('node:path');

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const outcomes = new Set(['needs_reply', 'awaiting_reply', 'booked', 'closed', 'unverified']);
const channels = new Set(['email', 'linkedin', 'booking']);
const kinds = new Set(['conversation', 'sent_search', 'booking_search', 'reply', 'booking', 'closure']);
const results = new Set(['read', 'none', 'found', 'unavailable']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const inboundTimestamp = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? Date.parse(`${value}T23:59:59.999Z`) : timestamp(value);
const https = value => { try { const url = new URL(value); return typeof value === 'string' && url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } };
const canonical = value => typeof value === 'string' ? value.replace(/\/$/,'') : '';
const linkedinThread = value => {
  if (typeof value !== 'string') return null;
  if (/^2-[A-Za-z0-9_=-]+$/.test(value)) return value;
  const match=value.match(/^https:\/\/(?:www\.)?linkedin\.com\/messaging\/thread\/([^/?#]+)\/?$/i);
  return match ? match[1] : null;
};
function conversationLinks(record = {}, queue = {}) {
  return [record,queue].flatMap(item=>[item.sourceUrl,item.emailSourceUrl,item.linkedinSourceUrl,...(Array.isArray(item.sourceLinks) ? item.sourceLinks : []),...(Array.isArray(item.relatedThreadIds) ? item.relatedThreadIds : [])]).filter(value=>https(value) && /^https:\/\/(?:mail\.google\.com\/|(?:www\.)?linkedin\.com\/messaging\/thread\/)/i.test(value));
}

// Infer requirements from saved channels as well as the submitted declaration.
// A collector cannot omit LinkedIn simply because only its email tool is available.
function neededCoverage(record = {}, queue = {}, declared = []) {
  const needed = new Set(Array.isArray(declared) ? declared.filter(channel => channels.has(channel)) : []);
  for (const item of [record, queue]) {
    const links = [item.sourceUrl, item.emailSourceUrl, item.linkedinSourceUrl, ...(Array.isArray(item.sourceLinks) ? item.sourceLinks : []), ...(Array.isArray(item.relatedThreadIds) ? item.relatedThreadIds : [])];
    const savedChannels = [item.channel, ...(Array.isArray(item.channels) ? item.channels : [])];
    if (savedChannels.some(channel => ['email', 'gmail'].includes(channel)) || item.recipientEmail || links.some(link => typeof link === 'string' && /^https:\/\/mail\.google\.com\//i.test(link))) needed.add('email');
    if (savedChannels.includes('linkedin') || links.some(link => linkedinThread(link))) needed.add('linkedin');
    if (https(item.schedulingUrl)) needed.add('booking');
  }
  return [...needed].sort();
}

function normalizeConversationReview(review, record = {}, queue = {}) {
  if (!object(review)) return null;
  const checkedAt = timestamp(review.checkedAt) === null ? null : review.checkedAt;
  const needed = neededCoverage(record, queue, review.neededCoverage);
  const evidence = (Array.isArray(review.evidence) ? review.evidence : []).filter(item => object(item)
    && channels.has(item.channel) && kinds.has(item.kind) && results.has(item.result)
    && timestamp(item.checkedAt) !== null && https(item.sourceUrl)
    && typeof item.detail === 'string' && item.detail.trim()).map(item => ({
      channel: item.channel, kind: item.kind, checkedAt: item.checkedAt, sourceUrl: item.sourceUrl,
      result: item.result, detail: item.detail.trim().slice(0, 2000),
      ...(https(item.conversationUrl) ? {conversationUrl:item.conversationUrl} : {}),
      ...(timestamp(item.eventAt) !== null ? {eventAt:item.eventAt} : {}),
      ...(['inbound','outbound'].includes(item.latestDirection) ? {latestDirection:item.latestDirection} : {}),
    }));
  const at = timestamp(checkedAt);
  const inbound = Math.max(...[record.lastInboundAt, record.lastInboundDate, queue.lastInboundAt, queue.lastInboundDate].map(inboundTimestamp).filter(value => value !== null), 0);
  const current = evidence.filter(item => at !== null && timestamp(item.checkedAt) <= at && at - timestamp(item.checkedAt) <= MAX_AGE_MS && timestamp(item.checkedAt) >= inbound);
  // Negative email searches and notification previews never establish LinkedIn state.
  const direct = item => item.channel === 'linkedin' ? /^https:\/\/(?:www\.)?linkedin\.com\/messaging\//i.test(item.sourceUrl)
    : item.channel === 'email' ? /^https:\/\/mail\.google\.com\//i.test(item.sourceUrl) : true;
  const known = new Set(conversationLinks(record,queue).map(canonical));
  const knownLinkedIn = new Set([record,queue].flatMap(item=>[...conversationLinks(item),...(Array.isArray(item.relatedThreadIds) ? item.relatedThreadIds : [])]).map(linkedinThread).filter(Boolean));
  const identity = item => known.has(canonical(item.conversationUrl || item.sourceUrl)) || knownLinkedIn.has(linkedinThread(item.conversationUrl || item.sourceUrl));
  const has = (channel, kind, result) => current.some(item => item.channel === channel && item.kind === kind && item.result === result && direct(item) && identity(item)
    && (kind !== 'conversation' || item.latestDirection === 'inbound'));
  const positive = kind => current.some(item => item.kind === kind && item.result === 'found' && direct(item) && identity(item)
    && timestamp(item.eventAt) !== null && timestamp(item.eventAt) <= timestamp(item.checkedAt) && timestamp(item.eventAt) >= inbound
    && (kind !== 'reply' || (item.channel !== 'booking' && item.latestDirection === 'outbound')));
  let outcome = outcomes.has(review.outcome) ? review.outcome : 'unverified';
  if (!checkedAt) outcome = 'unverified';
  else if (positive('booking')) outcome = 'booked';
  else if (positive('closure')) outcome = 'closed';
  else if (positive('reply')) outcome = 'awaiting_reply';
  else if (outcome === 'needs_reply') {
    const replyChannels = needed.filter(channel => channel !== 'booking');
    const linkedThreadsRead=[...knownLinkedIn].every(thread=>['conversation','sent_search'].every(kind=>current.some(item=>item.channel==='linkedin' && item.kind===kind && item.result===(kind==='conversation'?'read':'none') && (kind!=='conversation' || item.latestDirection==='inbound') && direct(item) && linkedinThread(item.conversationUrl || item.sourceUrl)===thread)));
    if (!replyChannels.length || !replyChannels.every(channel => has(channel, 'conversation', 'read') && has(channel, 'sent_search', 'none'))
      || !linkedThreadsRead || (needed.includes('booking') && !has('booking', 'booking_search', 'none'))) outcome = 'unverified';
  } else if (outcome !== 'unverified') outcome = 'unverified';
  const downgraded=outcome==='unverified' && review.outcome!=='unverified';
  return { checkedAt, outcome, summary: downgraded ? 'Verification needed: current evidence does not establish the latest state of every required conversation, sent reply and applicable booking check.' : typeof review.summary === 'string' ? review.summary.trim().slice(0, 2000) : '', evidence, neededCoverage: needed };
}

function conversationReviewState(record = {}, queue = {}, now = Date.now()) {
  const conversationReview = normalizeConversationReview(record.conversationReview, record, queue);
  const at = timestamp(conversationReview?.checkedAt);
  const inbound = [record.lastInboundAt, record.lastInboundDate, queue.lastInboundAt, queue.lastInboundDate].map(inboundTimestamp).filter(value => value !== null);
  const evidenceAt = conversationReview?.evidence.map(item => timestamp(item.checkedAt)).filter(value => value !== null) || [];
  const conversationReviewFresh = at !== null && at <= now && now - at <= MAX_AGE_MS
    && conversationReview.outcome !== 'unverified' && !inbound.some(value => value > at)
    && !(timestamp(queue.sentAt) !== null && timestamp(queue.sentAt) > at)
    && evidenceAt.length > 0 && evidenceAt.every(value => value <= now && now - value <= MAX_AGE_MS);
  return { conversationReview, conversationReviewFresh };
}

function reviewPlan({ brief = {}, queue = {}, now = Date.now(), limit = 3 } = {}) {
  const records = new Map((brief.opportunities || []).filter(object).map(item => [item.id, item]));
  const eligible = (queue.items || []).filter(object).filter(item => {
    const record = records.get(item.id) || {};
    if (!item.id || /^(?:hold|declined|dismissed|closed|expired|stale|archived|rejected|withdrawn|cancelled|canceled|meeting_booked|applied)/i.test(item.status || '')) return false;
    const reminder = Date.parse(item.nextReminderAt);
    if (Number.isFinite(reminder) && reminder > now) return false;
    const isDue=Number.isFinite(reminder) && reminder<=now;
    const sent=timestamp(item.sentAt);
    const latestInbound=Math.max(...[record.lastInboundAt,record.lastInboundDate,item.lastInboundAt,item.lastInboundDate].map(inboundTimestamp).filter(value=>value!==null),0);
    const hasSent=sent!==null || ['sent','awaiting_recruiter'].includes(item.status);
    if (hasSent && !isDue && !(sent!==null && latestInbound>sent)) return false;
    return ['ready_for_review', 'snoozed', 'reconnect_scheduled','sent','awaiting_recruiter'].includes(item.status) || isDue;
  }).map(item => {
    const record = records.get(item.id) || {};
    const due = Date.parse(item.nextReminderAt);
    const inbound = Math.max(...[record.lastInboundAt, record.lastInboundDate, item.lastInboundAt, item.lastInboundDate].map(inboundTimestamp).filter(value => value !== null), 0);
    return {item, record, due: Number.isFinite(due) && due <= now ? due : Infinity, inbound, ...conversationReviewState(record, item, now)};
  }).filter(value=>!['awaiting_reply','booked','closed'].includes(value.conversationReview?.outcome) || timestamp(value.conversationReview?.checkedAt)>now
    || (value.due!==Infinity && value.due>timestamp(value.conversationReview?.checkedAt)) || timestamp(value.item.reviewResumedAt)>timestamp(value.conversationReview?.checkedAt))
    .sort((a,b) => a.due - b.due || (Number(a.item.priority) || 999) - (Number(b.item.priority) || 999) || b.inbound - a.inbound || a.item.id.localeCompare(b.item.id));
  const top = eligible.slice(0, Math.max(0, Math.min(3, limit))).map(value=>({...value,explicitReview:
    (value.due!==Infinity && value.due>timestamp(value.conversationReview?.checkedAt))
    || (timestamp(value.item.reviewResumedAt)!==null && timestamp(value.item.reviewResumedAt)>timestamp(value.conversationReview?.checkedAt))}));
  return { schema: 'job-quest-outreach-review-plan/1', maxCandidates: 3,
    targets: top.filter(value => !value.conversationReviewFresh || value.explicitReview).map(({item, record}) => ({id:item.id, neededCoverage:neededCoverage(record,item), sourceLinks:[...new Set(conversationLinks(record,item).filter(link=>/^https:\/\/(?:mail\.google\.com\/|(?:www\.)?linkedin\.com\/messaging\/thread\/)/i.test(link)))], relatedThreadIds:[...new Set([...(Array.isArray(record.relatedThreadIds) ? record.relatedThreadIds : []),...(Array.isArray(item.relatedThreadIds) ? item.relatedThreadIds : [])].filter(value=>typeof value==='string' && (linkedinThread(value) || /^[a-f0-9]{10,}$/.test(value))))], schedulingUrl:item.schedulingUrl || record.schedulingUrl || null})),
    reusedIds: top.filter(value => value.conversationReviewFresh && !value.explicitReview).map(value => value.item.id),
  };
}

function readPlan(dataDir) {
  const read = filename => {try {return JSON.parse(fs.readFileSync(path.join(dataDir, 'outreach', filename), 'utf8'));} catch (error) {if(error.code === 'ENOENT') return {}; throw error;}};
  return reviewPlan({brief:read('brief.json'),queue:read('queue.json')});
}
if (require.main === module) {
  try {process.stdout.write(JSON.stringify(readPlan(process.argv[2])));} catch (error) {console.error('Outreach review plan unavailable; saved state was preserved.');process.exitCode=1;}
}
module.exports = {MAX_AGE_MS, neededCoverage, normalizeConversationReview, conversationReviewState, reviewPlan};
