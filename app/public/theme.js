/* Apply before first paint; appearance is local to this browser and shared with workbooks. */
(() => {
  const key = 'jobquest.theme';
  const valid = value => value === 'light' || value === 'dark';
  const listeners = new Set();
  let theme = 'dark';
  try {
    const saved = localStorage.getItem(key);
    const legacy = localStorage.getItem('workbook.theme');
    theme = valid(saved) ? saved : valid(legacy) ? legacy : 'dark';
  } catch { /* Storage can be unavailable; theme switching still works for this page. */ }
  const apply = next => {
    theme = valid(next) ? next : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    for (const listener of listeners) listener(theme);
    return theme;
  };
  const set = next => {
    if (!valid(next)) return theme;
    try { localStorage.setItem(key, next); } catch { /* Keep the in-memory choice. */ }
    return apply(next);
  };
  window.JobQuestTheme = {
    get: () => theme,
    set,
    toggle: () => set(theme === 'dark' ? 'light' : 'dark'),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) apply(valid(event.newValue) ? event.newValue : 'dark');
  });
  apply(theme);
})();
