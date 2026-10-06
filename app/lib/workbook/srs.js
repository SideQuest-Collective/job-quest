// app/lib/workbook/srs.js
const DAY = 24 * 60 * 60 * 1000;
const INTERVAL_DAYS = [1, 3, 7];

function srsFromHistory(history) {
  let st = null;
  const sorted = (Array.isArray(history) ? history : [])
    .filter((h) => h && typeof h.at === 'string' && !Number.isNaN(Date.parse(h.at)))
    .slice()
    .sort((a, b) => a.at.localeCompare(b.at));
  for (const h of sorted) {
    const t = Date.parse(h.at);
    if (h.grade === 'partial' || h.grade === 'missed') {
      st = { stage: 0, dueAt: new Date(t + INTERVAL_DAYS[0] * DAY).toISOString(), lastGradeAt: h.at, retired: false };
    } else if (h.grade === 'got' && st && !st.retired) {
      if (st.stage >= 2) st = { stage: 2, dueAt: null, lastGradeAt: h.at, retired: true };
      else {
        const stage = st.stage + 1;
        st = { stage, dueAt: new Date(t + INTERVAL_DAYS[stage] * DAY).toISOString(), lastGradeAt: h.at, retired: false };
      }
    }
  }
  return st;
}

module.exports = { INTERVAL_DAYS, srsFromHistory };
