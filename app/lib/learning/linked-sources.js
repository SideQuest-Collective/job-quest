// Read the same owned concepts as interview preparation. This adapter never
// writes interview configuration, starts capture, or changes a live selection.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function readLinkedSources({ interviewHome = process.env.INTERVIEW_HOME || path.join(os.homedir(), '.interview'), python = 'python3', run = spawnSync } = {}) {
  const home = path.resolve(interviewHome.replace(/^~(?=$|\/)/, os.homedir()));
  const script = path.join(home, 'app', 'preparation.py');
  const result = { sources: [], warnings: [], available: false };
  if (!fs.existsSync(script)) {
    result.warnings.push('Interview preparation is not installed; linked concept sources are unavailable.');
    return result;
  }
  const call = (args) => {
    const child = run(python, args[0] === '-c' ? args : [script, ...args], {
      env: { ...process.env, INTERVIEW_HOME: home, PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024,
    });
    if (child.error || child.status !== 0) throw new Error('Interview preparation could not read linked concepts. Existing snapshots and active sessions were not changed.');
    try { return JSON.parse(child.stdout); } catch { throw new Error('Interview preparation returned unreadable concept metadata.'); }
  };
  try {
    const listing = call(['catalog', '--round', 'system']);
    if (!Array.isArray(listing.sources)) throw new Error('Interview preparation returned an unsupported source catalog.');
    result.warnings.push(...(listing.warnings || []).filter((w) => typeof w === 'string'));
    const concepts = listing.sources.filter((s) => s.scope === 'concept' && s.kind === 'material' && s.id === `concept:${s.docId}`);
    if (!concepts.length) { result.available = true; return result; }
    // The CLI requires --output; call its read-only select() API instead so no
    // plan is written. "system" supplies catalog identity only, not a round
    // change or suggested/default selection in any live session.
    const selectApi = 'import importlib.util,json,sys; spec=importlib.util.spec_from_file_location("jq_linked_preparation",sys.argv[1]); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); print(json.dumps(mod.select("system",include=sys.argv[2:])))';
    const plan = call(['-c', selectApi, script, ...concepts.map((s) => s.id)]);
    if (plan.schema !== 'interview-preparation/1' || !Array.isArray(plan.selected)) throw new Error('Interview preparation returned an unsupported snapshot contract.');
    const ids = new Set(concepts.map((s) => s.id));
    const seen = new Set();
    result.sources = plan.selected.map((s) => {
      if (!ids.has(s.id) || seen.has(s.id) || s.id !== `concept:${s.docId}` || s.scope !== 'concept' || typeof s.content !== 'string' || typeof s.path !== 'string' || typeof s.resolvedPath !== 'string' || !['markdown', 'json'].includes(s.format)) throw new Error('Linked concept identity or snapshot is invalid.');
      seen.add(s.id);
      const sha256 = crypto.createHash('sha256').update(s.content).digest('hex');
      if (sha256 !== s.sha256) throw new Error('Linked concept snapshot hash does not match its content.');
      return { id: s.id, kind: 'concept', title: s.title, path: s.docId, physicalPath: s.path, resolvedPath: s.resolvedPath,
        sha256, content: s.content, format: s.format, linked: true, readOnly: true, provenance: 'interview-preparation/1' };
    });
    if (seen.size !== ids.size) throw new Error('A linked concept disappeared while references were being read. Reload before using it.');
    result.warnings = [...new Set([...result.warnings, ...(plan.warnings || []).filter((w) => typeof w === 'string')])];
    result.available = true;
  } catch (error) {
    result.sources = [];
    result.warnings.push(error.message);
  }
  return result;
}

// Do not silently let a pasted snapshot shadow a shared current source. The
// caller can show both versions, then request an explicit choice/refresh.
function linkedConflicts(savedSources, linkedSources) {
  const saved = new Map(savedSources.map((s) => [s.id, s]));
  return linkedSources.filter((s) => saved.has(s.id) && saved.get(s.id).sha256 !== s.sha256)
    .map((s) => ({ id: s.id, savedHash: saved.get(s.id).sha256, linkedHash: s.sha256, resolvedPath: s.resolvedPath }));
}

module.exports = { readLinkedSources, linkedConflicts };
