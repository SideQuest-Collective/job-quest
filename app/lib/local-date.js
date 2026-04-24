function pad2(value) {
  return String(value).padStart(2, '0');
}

function getLocalDateStamp(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function findRecordByDate(records, targetDate) {
  return (records || []).find((record) => record && record.date === targetDate) || null;
}

function preferTodayOrLatest(records, targetDate) {
  return findRecordByDate(records, targetDate) || ((records && records[0]) || null);
}

module.exports = {
  findRecordByDate,
  getLocalDateStamp,
  preferTodayOrLatest,
};
