// System Design mock interview state. A saved conversation is { messages } while in
// progress; completing it adds completedAt, endedEarly and score without touching messages
// that were already saved, apart from appending the interviewer's final feedback.

const SD_START_MARKER = '[Interview started]';
// The interviewer prompt asks for wrap-up feedback once the candidate has answered this often.
const SD_NATURAL_END_EXCHANGES = 8;

function sdUserExchanges(messages) {
  return (Array.isArray(messages) ? messages : []).filter(m => m && m.role === 'user' && m.content !== SD_START_MARKER).length;
}

// Reads a score out of interviewer feedback: "7/10", "7.5 / 10", "Score: 7 out of 10".
function findSdScore(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/(\d{1,2}(?:\.\d)?)\s*(?:\/|out of)\s*10\b/i);
  if (!match) return null;
  const score = Number(match[1]);
  return score >= 0 && score <= 10 ? score : null;
}

function lastAssistantMessage(conv) {
  const messages = conv && Array.isArray(conv.messages) ? conv.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i] && messages[i].role === 'assistant') return messages[i];
  return null;
}

// The interviewer already gave scored feedback in its last reply, so the interview has
// reached its natural end and can be marked complete without another runtime call.
function sdFeedbackGiven(conv) {
  const last = lastAssistantMessage(conv);
  return !!last && findSdScore(last.content) !== null;
}

function sdConversationStatus(conv) {
  if (!conv || !Array.isArray(conv.messages) || conv.messages.length === 0) return 'new';
  return conv.completedAt ? 'completed' : 'in-progress';
}

function sdTopicState(conv) {
  const status = sdConversationStatus(conv);
  return {
    hasConversation: status !== 'new',
    status,
    completedAt: status === 'completed' ? conv.completedAt : null,
    score: status === 'completed' && typeof conv.score === 'number' ? conv.score : null,
  };
}

function buildSdWrapUpPrompt(topic, conv, prepContext = '') {
  const history = (conv.messages || []).map(m => `${m.role === 'user' ? 'CANDIDATE' : 'INTERVIEWER'}: ${m.content}`).join('\n\n');
  const early = sdUserExchanges(conv.messages) < SD_NATURAL_END_EXCHANGES;
  return `You are a senior staff engineer who just ran a system design mock interview for: "${topic.title}".
${prepContext}
Here is the full conversation:

${history}

The candidate has ended the interview${early ? ' early, before every phase was covered' : ''}. Do not ask any more questions. Give your final feedback now:
- What went well
- What to improve${early ? ' (name the phases they did not reach: requirements, high-level design, deep dives, scaling, tradeoffs)' : ''}
- One next practice step
- A score written exactly as "Score: N/10", judged only on what the candidate actually showed
Keep it concise and use markdown formatting.`;
}

// Marks a conversation complete. feedback is the interviewer's final message, or null when
// the interview ends without one (runtime unavailable, or feedback already in the chat).
function completeSdConversation(conv, { feedback = null, now = new Date().toISOString() } = {}) {
  if (conv.completedAt) return conv;
  // Ended early means the candidate stopped before the interviewer gave scored feedback itself.
  const endedEarly = !sdFeedbackGiven(conv);
  if (feedback) conv.messages.push({ role: 'assistant', content: feedback, timestamp: now, kind: 'feedback' });
  const last = lastAssistantMessage(conv);
  const score = last ? findSdScore(last.content) : null;
  conv.completedAt = now;
  conv.endedEarly = endedEarly;
  conv.score = score;
  return conv;
}

module.exports = {
  SD_START_MARKER,
  SD_NATURAL_END_EXCHANGES,
  sdUserExchanges,
  findSdScore,
  sdFeedbackGiven,
  sdConversationStatus,
  sdTopicState,
  buildSdWrapUpPrompt,
  completeSdConversation,
};
