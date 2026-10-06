// app/lib/jobs/role-events.js
function diffRoleActions(prev, next) {
  const p = prev || {}, n = next || {};
  const fresh = (k) => (n[k] || []).filter((r) => !(p[k] || []).includes(r));
  return { saved: fresh('saved'), applied: fresh('applied') };
}

function diffTracker(prev, next) {
  const p = prev || {}, n = next || {};
  const applied = Object.keys(n).filter((k) => n[k] && n[k].stage === 'applied' && (!p[k] || p[k].stage !== 'applied'));
  return { applied };
}

function createRoleEventBus() {
  const listeners = { saved: [], applied: [] };
  return {
    on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); },
    emit(event, roleKey) {
      for (const fn of listeners[event] || []) {
        try { fn(roleKey); } catch (err) { console.error(`[role-events] ${event} listener failed:`, err.message); }
      }
    },
  };
}

module.exports = { diffRoleActions, diffTracker, createRoleEventBus };
