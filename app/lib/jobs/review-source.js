// Configuration and preserved evidence are separate from verification of a run.
function reviewSourceInfo({ externalSelected = false, briefConfigured = false, nativeScheduleInstalled = false, reports = [] }) {
  const migrated = reports.filter(report => report?.migration?.schema === 'career-review-to-native-intel/1');
  const checks = migrated.flatMap(report => Array.isArray(report.roles) ? report.roles : []).map(role => role.checkedAt).filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value))).sort((a,b)=>Date.parse(b)-Date.parse(a));
  return { mode: externalSelected ? 'external' : 'native', configured: externalSelected ? briefConfigured : nativeScheduleInstalled,
    externalRunVerification: externalSelected ? 'not_verified_by_native_status' : null,
    nativeScheduleInstalled, migratedReports: migrated.length, migratedRoles: migrated.reduce((n,report)=>n+(Array.isArray(report.roles)?report.roles.length:0),0),
    lastMigratedCheckAt: checks[0] || null };
}
module.exports = { reviewSourceInfo };
