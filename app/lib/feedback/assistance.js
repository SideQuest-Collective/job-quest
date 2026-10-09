// Evidence is monotonic for an answer; hiding guidance never erases exposure.
// Missing legacy metadata remains unknown rather than proving independence.
function mergeAssistance(previous, incoming) {
  const known = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!known(previous) && !known(incoming)) return null;
  const result = {...(known(previous) ? previous : {}), ...(known(incoming) ? incoming : {})};
  for (const key of ['assisted','revealed','hintUsed']) {
    if (previous?.[key] === true || incoming?.[key] === true) result[key] = true;
  }
  return result;
}
module.exports = {mergeAssistance};
