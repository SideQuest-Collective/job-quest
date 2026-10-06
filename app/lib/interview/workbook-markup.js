// app/lib/interview/workbook-markup.js
// Pure rendering of the "Asked in your interviews" chapter in the workbook format (workbooks spec §4).
const CHAPTER_ID = 'asked-in-interviews';
const CHAPTER_TITLE = 'Asked in your interviews';
const ROUND_LABEL = { coding: 'Coding', system: 'System design', behavioral: 'Behavioral', recruiter: 'Recruiter', screen: 'Screen' };

function qidFor(folder, n) {
  return `iv-${String(folder).replace(/[^0-9]/g, '')}-${n}`;
}

// Agent text must never open a new markup block or close the viewer's <script>.
function safeBlock(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/<\/script/gi, '<\\/script')
    .replace(/^@@/gm, '\\@@')
    .trim();
}

function attr(text) {
  return String(text == null ? '' : text).replace(/["\r\n]+/g, ' ').trim();
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

function renderQuestion(item, { qid, companySlug, date, round }) {
  const label = (ROUND_LABEL[round] || round || 'interview').toLowerCase();
  return [
    `@@q id=${qid} company=${companySlug} topic="${attr(item.topic)}" type=${item.type} diff=${item.diff} chapter=${CHAPTER_ID}`,
    `**${safeBlock(item.title)}**`,
    '',
    safeBlock(item.prompt),
    '',
    `_Asked in your ${label} round on ${date}; graded ${item.grade} from the debrief._`,
    '@@rubric',
    safeBlock(item.rubric),
    '@@answer',
    safeBlock(item.answer),
    '',
  ].join('\n');
}

function renderChapter({ companySlug, sessions, questions }) {
  const count = (g) => questions.filter((q) => q.item.grade === g).length;
  const head = [
    `@@chapter id=${CHAPTER_ID} company=${companySlug} topic="Interviews" title="${CHAPTER_TITLE}"`,
    '## In plain English',
    '',
    'These are the questions interviewers actually asked you, taken from your /interview session debriefs. Each one is graded from the debrief, so the ones you missed come back in your review queue.',
    '',
    'Sessions:',
    ...sessions.map((s) => `- ${s.date}: ${ROUND_LABEL[s.round] || s.round} round${s.interviewer ? ` with ${s.interviewer}` : ''}, ${s.durationMin} min (${plural(s.count, 'question')})`),
    '',
    '## Key takeaways',
    '',
    `- ${count('missed')} missed, ${count('partial')} partial, ${count('got')} got across ${plural(questions.length, 'question')}.`,
    '- Re-answer every missed or partial question out loud before your next round.',
    '',
  ];
  return `${head.join('\n')}\n${questions.map((q) => renderQuestion(q.item, { ...q, companySlug })).join('\n')}`;
}

module.exports = { CHAPTER_ID, CHAPTER_TITLE, ROUND_LABEL, qidFor, renderQuestion, renderChapter };
