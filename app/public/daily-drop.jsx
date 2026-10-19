/* global React */
// Daily Drop: today's podcast episode plus the master cheat sheet across every saved role.
(() => {
  const { useState, useEffect, useMemo, useRef } = React;
  const req = async (url, method, body) => {
    const res = await fetch(url, method ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) } : undefined);
    const v = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(v.error || 'Request failed');
    return v;
  };
  const mins = (s) => `${Math.floor((s || 0) / 60)}:${String((s || 0) % 60).padStart(2, '0')}`;
  const pretty = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const chip = (active) => ({ padding: '4px 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer', border: '1px solid var(--border)', background: active ? 'var(--amber-dim)' : 'transparent', color: active ? 'var(--amber)' : 'var(--text-secondary)' });
  const tag = { fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'var(--bg-elevated)', color: 'var(--text-secondary)', marginRight: 6, display: 'inline-block', marginTop: 4 };

  const openPodcastSetup = () => window.dispatchEvent(new CustomEvent('jq:open-setup', { detail: { section: 'podcast' } }));

  // The key is only "connected" once Google has actually returned audio for it. Until then the fix is shown here.
  const keyProblem = (state) => state.hasKey && !(state.key && state.key.verified) ? state.key || { message: 'This key has not been checked yet.', remediation: '' } : null;

  function SetupPrompt({ state }) {
    const missing = [!state.hasKey && 'Gemini voices'].filter(Boolean);
    const problem = keyProblem(state);
    if (!missing.length && !problem) return null;
    return (
      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14, color: 'var(--text-secondary)', flex: 1, minWidth: 240 }}>
          {missing.length > 0 && <div>Daily Drop still needs its {missing.join(' and ')}.</div>}
          {problem && <div role="alert" style={{ color: 'var(--rose)', marginTop: missing.length ? 6 : 0 }}>{['unchecked', 'recording-changed'].includes(problem.code) ? "The saved Gemini key hasn't been tested yet. Check it in Setup → Podcast." : "The saved Gemini key can't record audio yet. Fix it in Setup → Podcast."}</div>}
        </div>
        <button className="btn btn-primary" onClick={openPodcastSetup}>Open podcast setup</button>
      </div>
    );
  }

  // Manage the Gemini key here: see whether it works, replace it, check it again or remove it.
  // The key itself never comes back from the server; only its last four characters do.
  function VoicesCard({ state, reload, disabled = false, onBusyChange = () => {} }) {
    const [editing, setEditing] = useState(false), [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [note, setNote] = useState('');
    const keyOperation = useRef(false);
    const locked = busy || disabled;
    const key = state.key || { verified: false, code: 'no-key', source: 'none' };
    const verdict = (r) => (r.key.verified ? 'Voices connected.' : `${r.key.message} ${r.key.remediation}`);
    const run = async (fn) => {
      if (keyOperation.current || disabled) return;
      keyOperation.current = true; setBusy(true); onBusyChange(true); setNote('');
      try { await fn(); } catch (e) { setNote(e.message); }
      finally { try { await reload(); } finally { keyOperation.current = false; setBusy(false); onBusyChange(false); } }
    };
    const save = () => run(async () => { const r = await req('/api/podcast/config', 'PUT', { apiKey: draft }); setDraft(''); setEditing(false); setNote(verdict(r)); });
    const check = () => run(async () => setNote(verdict(await req('/api/podcast/key/verify', 'POST'))));
    const remove = () => { if (window.confirm('Remove the saved Gemini key? Episodes stop until a new one is added.')) run(async () => { await req('/api/podcast/key', 'DELETE'); setNote('Key removed.'); }); };
    const when = key.checkedAt ? new Date(key.checkedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
    return (
      <div className="card" aria-label="Gemini audio">
        <div className="card-title" style={{ fontWeight: 600, marginBottom: 8 }}>Gemini audio</div>
        {!state.hasKey && <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 0 }}>No Gemini key saved. The hosts need one to record. Create it at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">aistudio.google.com/apikey</a>; a short test recording checks it before anything else runs.</p>}
        {state.hasKey && key.verified && <p role="status" style={{ fontSize: 14, color: 'var(--emerald)', marginTop: 0 }}>Connected. Key {key.hint}{key.source === 'env' ? ' from GEMINI_API_KEY' : ''}{when ? `, checked ${when}` : ''}.</p>}
        {state.hasKey && !key.verified && <p role="alert" style={{ fontSize: 14, color: 'var(--rose)', marginTop: 0, lineHeight: 1.5 }}>Key {key.hint} {['unchecked', 'recording-changed'].includes(key.code) ? 'needs a recording check.' : "can't record audio."} {key.message} {key.remediation}</p>}
        {editing && <label style={{ fontSize: 14, display: 'block', marginBottom: 10 }}>New Gemini API key<input type="password" disabled={locked} autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Paste key" style={field} /></label>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {editing
            ? <>
                <button className="btn btn-primary" style={{ minHeight: 44 }} disabled={locked || !draft.trim()} onClick={save}>{busy ? 'Testing…' : 'Save and test'}</button>
                <button className="btn btn-secondary" style={{ minHeight: 44 }} disabled={locked} onClick={() => { setEditing(false); setDraft(''); }}>Cancel</button>
              </>
            : <button className="btn btn-primary" style={{ minHeight: 44 }} disabled={locked || key.source === 'env'} onClick={() => setEditing(true)}>{state.hasKey ? 'Replace key' : 'Add key'}</button>}
          {state.hasKey && !editing && <button className="btn btn-secondary" style={{ minHeight: 44 }} disabled={locked} onClick={check}>{busy ? 'Checking…' : 'Check the key again'}</button>}
          {state.hasKey && !editing && key.source !== 'env' && <button className="btn btn-secondary" style={{ minHeight: 44 }} disabled={locked} onClick={remove}>Remove key</button>}
        </div>
        {key.source === 'env' && <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 10 }}>This key is set by the GEMINI_API_KEY environment variable, so it can only be changed there.</p>}
        {note && <div role="status" style={{ fontSize: 13, marginTop: 10, color: 'var(--text-secondary)' }}>{note}</div>}
      </div>
    );
  }

  function Today({ state, reload }) {
    const [sel, setSel] = useState(null), [script, setScript] = useState(null), [showScript, setShowScript] = useState(false), [note, setNote] = useState('');
    const eps = state.episodes || [];
    const epId = (e) => e.id || e.date;
    const ep = eps.find((e) => epId(e) === sel) || eps[0];
    useEffect(() => { setScript(null); setShowScript(false); }, [ep && epId(ep)]);
    const loadScript = async () => { if (!script) setScript(await req(`/api/podcast/episodes/${epId(ep)}/script`)); setShowScript((v) => !v); };
    const generate = async () => { setNote(''); try { await req('/api/podcast/generate', 'POST', { force: true, deliver: false }); setNote('Making a fresh episode. This takes a few minutes.'); reload(); } catch (e) { setNote(e.message); } };
    const fuzzy = async (c) => { await req('/api/podcast/fuzzy', 'POST', { id: c.id }); setNote(`"${c.title}" will come back tomorrow.`); };
    const busy = state.running || (ep && ep.status === 'building');
    return (
      <div>
        <SetupPrompt state={state} />
        <div className="card">
          {!ep && <p style={{ color: 'var(--text-secondary)' }}>No episodes yet. {state.schedule && state.schedule.installed ? `The next scheduled recording is at ${state.schedule.time || `${String(state.config.hour).padStart(2, '0')}:${String(state.config.minute).padStart(2, '0')}`}. This Mac needs to be awake.` : 'Automatic recording is off. Open podcast setup to add a schedule, or make an episode now.'}</p>}
          {ep && (
            <>
              <div style={{ fontSize: 12, color: 'var(--amber)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: 1 }}>{pretty(ep.date)}{ep.seconds ? ` · ${mins(ep.seconds)}` : ''}</div>
              <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 24, margin: '6px 0 4px', color: 'var(--text)', textTransform: 'none', letterSpacing: 0 }}>{ep.title || 'Episode in progress'}</h3>
              {ep.summary && <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>{ep.summary}</p>}
              {ep.status === 'ready' && <audio controls preload="metadata" src={`/api/podcast/episodes/${epId(ep)}/audio`} style={{ width: '100%', margin: '8px 0 12px' }} />}
              {ep.status === 'building' && <div role="status" style={{ color: 'var(--text-secondary)', fontSize: 14 }}>Working: {ep.step}…</div>}
              {ep.status === 'failed' && <div role="alert" style={{ color: 'var(--rose)', fontSize: 14 }}>Last run failed: {ep.error}</div>}
              {ep.takeaways && ep.takeaways.length > 0 && (
                <div style={{ margin: '12px 0' }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Say these out loud today</div>
                  <ol style={{ margin: 0, paddingLeft: 20 }}>{ep.takeaways.map((t, i) => <li key={i} style={{ marginBottom: 4 }}>{t}</li>)}</ol>
                </div>
              )}
              {ep.concepts && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Covered. Tap "Still fuzzy" to hear it again tomorrow.</div>
                  {ep.concepts.map((c) => (
                    <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 14 }}>
                        <span style={{ ...tag, color: c.kind === 'weak-spot' ? 'var(--rose)' : c.kind === 'review' ? 'var(--violet)' : 'var(--cyan)' }}>{c.kind === 'weak-spot' ? 'from your interviews' : c.kind === 'review' ? 'review' : 'cheat sheet'}</span>
                        {c.title}
                      </div>
                      <button className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 10px', whiteSpace: 'nowrap' }} onClick={() => fuzzy(c)}>Still fuzzy</button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            {ep && ep.status === 'ready' && <button className="btn btn-secondary" onClick={loadScript}>{showScript ? 'Hide transcript' : 'Read transcript'}</button>}
            <button className="btn btn-secondary" style={{ minHeight: 44 }} disabled={busy || !(state.key && state.key.verified)} title={state.key && state.key.verified ? undefined : 'Connect a working Gemini key first'} onClick={generate}>{busy ? 'Making episode…' : 'Make a new episode now'}</button>
          </div>
          {note && <div role="status" style={{ fontSize: 13, marginTop: 10, color: 'var(--text-secondary)' }}>{note}</div>}
          {showScript && script && (
            <div style={{ marginTop: 16, maxHeight: 420, overflow: 'auto', fontSize: 14, lineHeight: 1.6 }}>
              {script.segments.map((s, i) => s.type === 'pause'
                ? <div key={i} style={{ color: 'var(--amber)', fontStyle: 'italic', margin: '6px 0' }}>[pause {s.seconds}s, answer in your head]</div>
                : <p key={i} style={{ margin: '6px 0' }}><strong style={{ color: s.speaker === state.config.hosts[0].name ? 'var(--emerald)' : 'var(--blue)' }}>{s.speaker}:</strong> {s.text}</p>)}
            </div>
          )}
        </div>
        {eps.length > 1 && (
          <div className="card">
            <div className="card-title" style={{ fontWeight: 600, marginBottom: 8 }}>Past episodes</div>
            {eps.map((e) => (
              <button key={epId(e)} onClick={() => setSel(epId(e))} className="btn btn-secondary" style={{ display: 'flex', width: '100%', justifyContent: 'space-between', marginBottom: 6, textAlign: 'left', borderColor: ep && epId(e) === epId(ep) ? 'var(--amber)' : undefined }}>
                <span>{pretty(e.date)} · {e.title || e.status}</span><span style={{ color: 'var(--text-muted)' }}>{e.seconds ? mins(e.seconds) : ''}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Ranked topics the upcoming interviews are likely to ask, aggregated from the live roles' workbooks, with concept sheets.
  function Topics() {
    const [t, setT] = useState(null), [err, setErr] = useState(''), [open, setOpen] = useState(null), [busy, setBusy] = useState(false);
    const load = () => req('/api/podcast/topics').then(setT).catch((e) => setErr(e.message));
    useEffect(() => { load(); }, []);
    const refresh = async () => { setBusy(true); try { await req('/api/podcast/topics/refresh', 'POST'); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); } };
    if (err) return <div role="alert" className="card" style={{ color: 'var(--rose)' }}>{err}</div>;
    if (!t) return <div className="card">Loading…</div>;
    const withSheet = t.topics.filter((x) => x.sheet).length;
    return (
      <div>
        <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
            {t.topics.length} topics ranked from the questions your live roles' workbooks expect · {withSheet} with a concept sheet (a few more are built each morning)
          </div>
          <button className="btn btn-secondary" style={{ minHeight: 44 }} disabled={busy} onClick={refresh}>{busy ? 'Ranking…' : 'Re-rank now'}</button>
        </div>
        {t.topics.map((x, i) => (
          <div key={x.id} className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, cursor: 'pointer' }} onClick={() => setOpen(open === x.id ? null : x.id)}>
              <div>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--amber)', marginRight: 10 }}>{i + 1}</span>
                <span style={{ fontWeight: 600, fontSize: 16 }}>{x.title}</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{x.questionCount} questions · {x.roleCount} role{x.roleCount === 1 ? '' : 's'} · {x.sheet ? `${x.sheet.cards.length} cards` : 'sheet pending'}</div>
            </div>
            {open === x.id && (
              <div style={{ marginTop: 12 }}>
                {x.sheet ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
                    {x.sheet.cards.map((c, k) => (
                      <div key={k} style={{ background: 'var(--bg-surface)', borderRadius: 10, padding: 12 }}>
                        <div style={{ fontSize: 11, color: 'var(--amber)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: 1 }}>{c.category}</div>
                        <div style={{ fontWeight: 600, margin: '4px 0 6px' }}>{c.title}</div>
                        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.5 }}>{c.bullets.map((b, j) => <li key={j} style={{ marginBottom: 4 }}>{b}</li>)}</ul>
                        {c.code && <pre style={{ fontSize: 12, background: 'var(--bg-deep)', padding: 10, borderRadius: 8, overflow: 'auto', marginTop: 8 }}>{c.code}</pre>}
                      </div>
                    ))}
                  </div>
                ) : <p style={{ fontSize: 14, color: 'var(--text-secondary)' }}>The concept sheet for this topic hasn't been written yet. Episodes build the top few each morning.</p>}
                <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '12px 0 6px' }}>Anticipated questions</div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.5 }}>{x.questions.map((q, j) => <li key={j} style={{ marginBottom: 4 }}>{q.prompt}</li>)}</ul>
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }

  function Master({ state }) {
    const [m, setM] = useState(null), [err, setErr] = useState(''), [company, setCompany] = useState('all'), [cat, setCat] = useState('all'), [q, setQ] = useState(''), [sharedOnly, setSharedOnly] = useState(false);
    useEffect(() => { req('/api/podcast/master').then(setM).catch((e) => setErr(e.message)); }, []);
    const companies = useMemo(() => (m ? [...new Set(m.sources.map((s) => s.company))] : []), [m]);
    const cats = useMemo(() => (m ? [...new Set(m.cards.map((c) => c.category))] : []), [m]);
    const cards = useMemo(() => (m ? m.cards.filter((c) => (company === 'all' || c.companies.includes(company)) && (cat === 'all' || c.category === cat) && (!sharedOnly || c.shared)
      && (!q || `${c.title} ${c.bullets.join(' ')}`.toLowerCase().includes(q.toLowerCase()))) : []), [m, company, cat, q, sharedOnly]);
    if (err) return <div role="alert" className="card" style={{ color: 'var(--rose)' }}>{err}</div>;
    if (!m) return <div className="card">Loading…</div>;
    return (
      <div>
        <div className="card">
          <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
            {m.cards.length} cards from {m.sources.length} roles · {m.cards.filter((c) => c.shared).length} shared across companies
            {m.missing.length > 0 && <> · {m.missing.length} saved roles still need a sheet (built a few each morning)</>}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <select value={company} onChange={(e) => setCompany(e.target.value)} aria-label="Company" style={{ background: 'var(--bg-surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px' }}>
              <option value="all">All companies</option>{companies.map((c) => <option key={c}>{c}</option>)}
            </select>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search cards" style={{ flex: 1, minWidth: 160, background: 'var(--bg-surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px' }} />
            <button style={chip(sharedOnly)} onClick={() => setSharedOnly(!sharedOnly)}>Shared only</button>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            {['all', ...cats].map((c) => <button key={c} style={chip(cat === c)} onClick={() => setCat(c)}>{c}</button>)}
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {cards.map((c) => (
            <div key={c.id} className="card" style={{ marginBottom: 0 }}>
              <div style={{ fontSize: 11, color: 'var(--amber)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: 1 }}>{c.category}{c.shared ? ' · shared' : ''}</div>
              <div style={{ fontWeight: 600, fontSize: 16, margin: '4px 0 8px' }}>{c.title}</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.5 }}>{c.bullets.map((b, i) => <li key={i} style={{ marginBottom: 4 }}>{b}</li>)}</ul>
              {c.code && <pre style={{ fontSize: 12, background: 'var(--bg-deep)', padding: 10, borderRadius: 8, overflow: 'auto', marginTop: 8 }}>{c.code}</pre>}
              <div style={{ marginTop: 8 }}>{c.companies.map((co) => <span key={co} style={tag}>{co}</span>)}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function DailyDrop({ active }) {
    const [state, setState] = useState(null), [err, setErr] = useState(''), [tab, setTab] = useState('today');
    const timer = useRef(null);
    const reload = () => req('/api/podcast').then((s) => { setState(s); setErr(''); }).catch((e) => setErr(e.message));
    useEffect(() => { if (active) reload(); }, [active]);
    useEffect(() => {
      const building = state && (state.running || (state.episodes[0] && state.episodes[0].status === 'building'));
      clearInterval(timer.current);
      if (building && active) timer.current = setInterval(reload, 5000);
      return () => clearInterval(timer.current);
    }, [state, active]);
    return (
      <div style={{ maxWidth: 1050, margin: '0 auto' }}>
        <div className="page-header">
          <h2>Daily Drop</h2>
          <div className="greeting-sub">Interview lessons on the concepts your upcoming interviews are most likely to ask, ranked across your roles' workbooks.</div>
          <button className="btn btn-secondary" style={{ minHeight: 44, marginTop: 12 }} onClick={openPodcastSetup}>Podcast settings</button>
        </div>
        <nav style={{ display: 'flex', gap: 8, marginBottom: 20 }} aria-label="Daily Drop view">
          <button className={`btn ${tab === 'today' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('today')}>Episode</button>
          <button className={`btn ${tab === 'topics' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('topics')}>Topics</button>
          <button className={`btn ${tab === 'master' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTab('master')}>Master cheat sheet</button>
        </nav>
        {err && <div role="alert" className="card" style={{ color: 'var(--rose)' }}>{err}</div>}
        {state && tab === 'today' && <Today state={state} reload={reload} />}
        {state && tab === 'topics' && <Topics />}
        {state && tab === 'master' && <Master state={state} />}
      </div>
    );
  }

  // First-run wizard. Opens by itself once (after the app loads) until finished, postponed or declined.
  // Every step can be skipped; nothing runs until the person chooses it.
  const field = { display: 'block', width: '100%', minHeight: 44, font: 'inherit', fontSize: 16, marginTop: 6, padding: 10, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-surface)', color: 'var(--text)', boxSizing: 'border-box' };
  const STEPS = ['intro', 'voices', 'schedule', 'finish'];

  function DailyDropOnboarding({ setPage, autoOpen = true }) {
    const [info, setInfo] = useState(null), [open, setOpen] = useState(false), [step, setStep] = useState('intro');
    const [key, setKey] = useState(''), [time, setTime] = useState('08:30'), [imessage, setImessage] = useState(false);
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [done, setDone] = useState('');
    const dialog = useRef(null);
    const load = async () => { const v = await req('/api/podcast/onboarding'); setInfo(v); setImessage(setupConfig(v).imessage); if (v.schedule.time) setTime(v.schedule.time); return v; };
    useEffect(() => {
      let alive = true;
      const t = autoOpen ? setTimeout(() => load().then((v) => { if (alive && v.show) { setStep('intro'); setOpen(true); } }).catch(() => {}), 1200) : null;
      const manual = () => load().then(() => { setStep('intro'); setError(''); setDone(''); setOpen(true); }).catch((e) => setError(e.message));
      window.addEventListener('jq:daily-drop-setup', manual);
      return () => { alive = false; clearTimeout(t); window.removeEventListener('jq:daily-drop-setup', manual); };
    }, []);
    useEffect(() => { if (open && dialog.current) dialog.current.focus(); }, [open, step]);
    const act = async (fn) => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
    const close = (action) => act(async () => { if (action) await req('/api/podcast/onboarding', 'POST', { action }); setOpen(false); });
    if (!open || !info) return null;
    const idx = STEPS.indexOf(step);
    const next = () => setStep(STEPS[Math.min(idx + 1, STEPS.length - 1)]);
    const back = () => setStep(STEPS[Math.max(idx - 1, 0)]);
    const c = info.content;

    return (
      <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) close('later'); }}>
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="dd-onb-title" tabIndex={-1} ref={dialog} onKeyDown={(e) => { if (e.key === 'Escape') close('later'); }}>
          <div style={{ fontSize: 12, color: 'var(--amber)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: 1 }}>Optional · step {idx + 1} of {STEPS.length}</div>

          {step === 'intro' && <>
            <h2 id="dd-onb-title" style={{ margin: '8px 0' }}>Want a daily interview podcast?</h2>
            <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>Daily Drop is a 10 minute, two-host show made fresh each morning from your cheat sheets and your real interview debriefs. It asks you questions and pauses so you answer in your head, then covers whatever you flag as still fuzzy the next day.</p>
            <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>
              {c.roles ? `${c.roles} saved roles, ${c.sheets} with a cheat sheet.` : 'Save a few roles first; episodes are built from them.'}
              {c.missingSheets > 0 && ` The other ${c.missingSheets} get sheets a few at a time each morning.`}
            </p>
          </>}

          {step === 'voices' && <>
            <h2 id="dd-onb-title" style={{ margin: '8px 0' }}>Connect the voices</h2>
            {info.hasKey && info.key.verified && <p role="status" style={{ color: 'var(--emerald)' }}>A working Gemini key is already saved. You can keep it or paste a new one.</p>}
            {info.hasKey && !info.key.verified && <p role="alert" style={{ color: 'var(--rose)', lineHeight: 1.5 }}>The saved key can't record audio yet. {info.key.message} {info.key.remediation}</p>}
            {!info.hasKey && <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>The hosts use Gemini text-to-speech, about $0.16 an episode with a free tier. Create a key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">aistudio.google.com/apikey</a> and paste it here. It stays on this Mac, and a short test recording checks it works before anything else runs.</p>}
            <label style={{ fontSize: 14 }}>Gemini API key<input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={info.hasKey ? 'Saved' : 'Paste key'} style={field} /></label>
          </>}

          {step === 'schedule' && <>
            <h2 id="dd-onb-title" style={{ margin: '8px 0' }}>When should it arrive?</h2>
            <p style={{ color: 'var(--text-secondary)' }}>Episodes are made on this Mac, so it needs to be awake at that time.</p>
            <label style={{ fontSize: 14 }}>Every day at<input type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ ...field, colorScheme: 'dark' }} /></label>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14, fontSize: 14, opacity: info.imessageAvailable ? 1 : 0.6 }}>
              <input type="checkbox" checked={imessage && info.imessageAvailable} disabled={!info.imessageAvailable} onChange={(e) => setImessage(e.target.checked)} />
              Text me each episode on iMessage
            </label>
            {!info.imessageAvailable && <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Set up the Trainer's iMessage number to get episodes by text. You can always listen on the Daily Drop page.</p>}
          </>}

          {step === 'finish' && <>
            <h2 id="dd-onb-title" style={{ margin: '8px 0' }}>{done || 'You are set'}</h2>
            <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6 }}>The first episode arrives {info.schedule.installed ? `tomorrow at ${info.schedule.time || time}` : 'when you make one'}. Want one now? It takes a few minutes.</p>
          </>}

          {error && <p role="alert" style={{ color: 'var(--rose)', fontSize: 14 }}>{error}</p>}

          <div className="action-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 20 }}>
            {step === 'intro' && <>
              <button className="btn btn-primary" style={{ minHeight: 44 }} disabled={busy} onClick={next}>Set it up</button>
              <button className="btn btn-secondary" style={{ minHeight: 44 }} disabled={busy} onClick={() => close('later')}>Not now</button>
              <button className="btn btn-secondary" style={{ minHeight: 44 }} disabled={busy} onClick={() => close('skip')}>No thanks</button>
            </>}
            {step === 'voices' && <>
              <button className="btn btn-primary" style={{ minHeight: 44 }} disabled={busy || (!key.trim() && !info.hasKey)} onClick={() => act(async () => {
                // Saving runs a short test recording. A key that cannot record stays on this step with the fix shown.
                const r = key.trim() ? await req('/api/podcast/config', 'PUT', { apiKey: key }) : { key: info.key };
                setKey('');
                const v = await load();
                if (!(r.key && r.key.verified) && !(v.key && v.key.verified)) throw new Error(`${r.key ? r.key.message : ''} ${r.key ? r.key.remediation : ''}`.trim());
                next();
              })}>{key.trim() ? 'Save and test' : 'Continue'}</button>
              {info.hasKey && !info.key.verified && <button className="btn btn-secondary" style={{ minHeight: 44 }} disabled={busy} onClick={() => act(async () => { const r = await req('/api/podcast/key/verify', 'POST'); await load(); if (!r.key.verified) throw new Error(`${r.key.message} ${r.key.remediation}`.trim()); next(); })}>Check the key again</button>}
              <button className="btn btn-secondary" style={{ minHeight: 44 }} disabled={busy} onClick={back}>Back</button>
              <button className="btn btn-secondary" style={{ minHeight: 44 }} disabled={busy} onClick={next}>Skip this step</button>
            </>}
            {step === 'schedule' && <>
              <button className="btn btn-primary" style={{ minHeight: 44 }} disabled={busy} onClick={() => act(async () => { await req('/api/podcast/config', 'PUT', { imessage: imessage && info.imessageAvailable }); await req('/api/podcast/schedule', 'PUT', { time }); await req('/api/podcast/onboarding', 'POST', { action: 'done' }); await load(); setDone('You are set'); next(); })}>Schedule it</button>
              <button className="btn btn-secondary" style={{ minHeight: 44 }} disabled={busy} onClick={back}>Back</button>
              <button className="btn btn-secondary" style={{ minHeight: 44 }} disabled={busy} onClick={() => act(async () => { await req('/api/podcast/onboarding', 'POST', { action: 'done' }); setDone('Set up without a schedule'); next(); })}>Skip, I'll make episodes by hand</button>
            </>}
            {step === 'finish' && <>
              <button className="btn btn-primary" style={{ minHeight: 44 }} disabled={busy || !info.key.verified} onClick={() => act(async () => { await req('/api/podcast/generate', 'POST', { force: true, deliver: true }); setOpen(false); if (setPage) setPage('dailydrop'); })}>Make my first episode now</button>
              <button className="btn btn-secondary" style={{ minHeight: 44 }} disabled={busy} onClick={() => setOpen(false)}>I'll wait</button>
            </>}
          </div>
          {!info.key.verified && step === 'finish' && <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 10 }}>{info.hasKey ? `The saved Gemini key can't record audio yet. ${info.key.remediation}` : 'Add a Gemini key in Setup → Podcast before the first episode can be recorded.'}</p>}
        </div>
      </div>
    );
  }

  // Only non-secret drafts live in this browser tab. Refreshing status or the page never saves them.
  const PODCAST_DRAFT = 'jq:podcast-setup-draft:v1';
  const readSetupDraft = () => { try { return JSON.parse(sessionStorage.getItem(PODCAST_DRAFT) || 'null') || {}; } catch { return {}; } };
  const writeSetupDraft = (value) => { try { if (value.config || value.schedule) sessionStorage.setItem(PODCAST_DRAFT, JSON.stringify(value)); else sessionStorage.removeItem(PODCAST_DRAFT); } catch {} };
  const setupConfig = (info) => {
    const c = info.config;
    const explicit = info.imessageConfigured !== undefined ? info.imessageConfigured : info.configConfigured;
    return { targetMinutes: c.targetMinutes, imessage: explicit === false ? false : explicit === true ? c.imessage === true : c.imessage === true && !!(info.schedule.installed || (info.state && info.state.status === 'done')),
      hosts: c.hosts.map((host) => ({ ...host })), model: c.model, sheetsPerRun: c.sheetsPerRun, topicsPerEpisode: c.topicsPerEpisode, algorithmTopics: c.algorithmTopics };
  };
  const setupSchedule = (info) => ({ enabled: !!info.schedule.installed, time: info.schedule.time || `${String(info.config.hour).padStart(2, '0')}:${String(info.config.minute).padStart(2, '0')}` });
  const setupValidation = (draft) => {
    if (!draft || !Array.isArray(draft.hosts) || draft.hosts.length !== 2) return 'Two hosts are required.';
    if (draft.hosts.some((host) => !host.name.trim() || !host.voice.trim())) return 'Give each host a name and a Gemini voice.';
    if (draft.hosts[0].name.trim().toLowerCase() === draft.hosts[1].name.trim().toLowerCase()) return 'Use a different name for each host.';
    if (!Number.isInteger(Number(draft.targetMinutes)) || Number(draft.targetMinutes) < 5 || Number(draft.targetMinutes) > 20) return 'Choose a duration from 5 to 20 minutes.';
    if (draft.model !== undefined && !draft.model.trim()) return 'Enter a text-to-speech model.';
    for (const key of ['sheetsPerRun', 'topicsPerEpisode', 'algorithmTopics']) {
      if (draft[key] !== undefined && (!Number.isInteger(Number(draft[key])) || Number(draft[key]) < (key === 'topicsPerEpisode' ? 1 : 0) || Number(draft[key]) > 20)) return 'Content counts must be whole numbers up to 20; include at least one topic.';
    }
    return '';
  };

  function DailyDropSetupCard({ active = true }) {
    const restored = useRef(null);
    if (!restored.current) restored.current = readSetupDraft();
    const pending = useRef(restored.current);
    const [info, setInfo] = useState(null), [draft, setDraft] = useState(restored.current.config || null), [scheduleDraft, setScheduleDraft] = useState(restored.current.schedule || null);
    const [error, setError] = useState(''), [note, setNote] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState('');
    const loadingRef = useRef(false);
    const load = async () => {
      if (loadingRef.current) return;
      loadingRef.current = true; setLoading(true); setError('');
      try {
        const value = await req('/api/podcast/onboarding');
        setInfo(value);
        if (!pending.current.config) setDraft(setupConfig(value));
        if (!pending.current.schedule) setScheduleDraft(setupSchedule(value));
      } catch (e) { setError(e.message); }
      finally { loadingRef.current = false; setLoading(false); }
    };
    useEffect(() => { if (active) load(); }, [active]);
    const editConfig = (patch) => { const next = { ...draft, ...patch }; pending.current = { ...pending.current, config: next }; writeSetupDraft(pending.current); setDraft(next); setNote(''); };
    const editSchedule = (patch) => { const next = { ...scheduleDraft, ...patch }; pending.current = { ...pending.current, schedule: next }; writeSetupDraft(pending.current); setScheduleDraft(next); setNote(''); };
    const saveConfig = async (e) => {
      e.preventDefault(); const validation = setupValidation(draft);
      if (validation) { setError(validation); return; }
      setBusy('config'); setError(''); setNote('');
      try {
        const patch = { ...draft, targetMinutes: Number(draft.targetMinutes), hosts: draft.hosts.map((host) => ({ ...host, name: host.name.trim(), voice: host.voice.trim() })) };
        for (const key of ['sheetsPerRun', 'topicsPerEpisode', 'algorithmTopics']) if (patch[key] !== undefined) patch[key] = Number(patch[key]);
        // Availability never silently clears a previously saved delivery preference.
        if (!info.imessageAvailable) delete patch.imessage;
        await req('/api/podcast/config', 'PUT', patch);
        delete pending.current.config; writeSetupDraft(pending.current); setNote('Podcast preferences saved.'); await load();
      } catch (e) { setError(e.message); }
      finally { setBusy(''); }
    };
    const saveSchedule = async (e) => {
      e.preventDefault();
      if (scheduleDraft.enabled && !/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduleDraft.time)) { setError('Choose a valid recording time.'); return; }
      setBusy('schedule'); setError(''); setNote('');
      try {
        await req('/api/podcast/schedule', 'PUT', scheduleDraft);
        delete pending.current.schedule; writeSetupDraft(pending.current); setNote(scheduleDraft.enabled ? 'Daily recording schedule saved.' : 'Automatic recording is off.'); await load();
      } catch (e) { setError(e.message); }
      finally { setBusy(''); }
    };
    const discard = () => { pending.current = {}; writeSetupDraft({}); setDraft(setupConfig(info)); setScheduleDraft(setupSchedule(info)); setError(''); setNote('Unsaved changes discarded.'); };
    const control = { minHeight: 44, fontSize: 14 };
    const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 16 };
    return (
      <section aria-label="Daily Drop podcast" style={{ maxWidth: 820 }}>
        <div className="card" style={{ fontSize: 14, lineHeight: 1.6 }}>
          <h3 style={{ marginTop: 0 }}>Daily Drop podcast</h3>
          <p>Connect Gemini, choose your hosts, and decide when this Mac records interview lessons. Listen on the Daily Drop page.</p>
          <button type="button" className="btn btn-secondary" style={control} disabled={loading || !!busy} onClick={load}>{loading ? 'Refreshing…' : 'Refresh podcast status'}</button>
          {(pending.current.config || pending.current.schedule) && <p role="status" style={{ color: 'var(--amber)', marginBottom: 0 }}>You have unsaved changes. They stay in this browser tab until you save or discard them.</p>}
        </div>
        {error && <div className="card" role="alert" style={{ color: 'var(--rose)', fontSize: 14 }}>{error} <button type="button" className="btn btn-secondary" style={control} disabled={loading || !!busy} onClick={load}>Retry status check</button></div>}
        {note && <div className="card" role="status" style={{ fontSize: 14 }}>{note}</div>}
        {!info && !error && <div className="card" role="status">Loading podcast settings…</div>}
        {info && draft && scheduleDraft && <>
          <VoicesCard state={info} reload={load} disabled={!!busy || loading} onBusyChange={(value) => setBusy(value ? 'key' : '')} />
          <form className="card" aria-label="Recording schedule" onSubmit={saveSchedule}>
            <h3 style={{ marginTop: 0 }}>Recording schedule</h3>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)' }}>{info.schedule.installed ? `Daily recording is on at ${info.schedule.time}.` : 'Automatic recording is off. You can make episodes by hand on Daily Drop.'} This Mac must be awake for scheduled recordings.</p>
            <fieldset disabled={!!busy || loading} style={{ padding: 0, border: 0, margin: 0 }}>
              <div style={grid}>
                <label style={{ fontSize: 14 }}>Automatic recording<select style={field} value={scheduleDraft.enabled ? 'daily' : 'off'} onChange={(e) => editSchedule({ enabled: e.target.value === 'daily' })}><option value="off">Off — make episodes by hand</option><option value="daily">Every day</option></select></label>
                <label style={{ fontSize: 14 }}>Local recording time<input type="time" style={field} value={scheduleDraft.time} disabled={!scheduleDraft.enabled} onChange={(e) => editSchedule({ time: e.target.value })} required={scheduleDraft.enabled} /></label>
              </div>
              <button type="submit" className="btn btn-primary" style={{ ...control, marginTop: 16 }} disabled={!pending.current.schedule}>{busy === 'schedule' ? 'Saving schedule…' : 'Save recording schedule'}</button>
            </fieldset>
          </form>
          <form className="card" aria-label="Podcast preferences" onSubmit={saveConfig}>
            <h3 style={{ marginTop: 0 }}>Podcast preferences</h3>
            <fieldset disabled={!!busy || loading} style={{ padding: 0, border: 0, margin: 0 }}>
              <label style={{ display: 'block', fontSize: 14, maxWidth: 300 }}>Target duration (minutes)<input type="number" min="5" max="20" step="1" required value={draft.targetMinutes} style={field} onChange={(e) => editConfig({ targetMinutes: e.target.value })} /></label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 44, marginTop: 16, fontSize: 14 }}><input type="checkbox" style={{ width: 20, height: 20, flexShrink: 0 }} checked={draft.imessage} disabled={!info.imessageAvailable} onChange={(e) => editConfig({ imessage: e.target.checked })} />Text scheduled episodes to me on iMessage</label>
              <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginTop: 4 }}>{info.imessageAvailable ? 'Opt in to delivery to your saved Trainer number. Saving preferences sends no message.' : 'Ask your Job Quest agent to configure the Trainer’s iMessage recipient before enabling delivery. Any saved delivery preference is preserved.'}</p>
              <div style={grid}>{draft.hosts.map((host, i) => <div key={i} style={{ minWidth: 0 }}>
                <h4 style={{ fontSize: 15, marginBottom: 12 }}>Host {i + 1}</h4>
                <label style={{ display: 'block', fontSize: 14 }}>Host {i + 1} name<input style={field} required value={host.name} onChange={(e) => editConfig({ hosts: draft.hosts.map((h, j) => j === i ? { ...h, name: e.target.value } : h) })} /></label>
                <label style={{ display: 'block', fontSize: 14, marginTop: 12 }}>Host {i + 1} Gemini voice<input style={field} required value={host.voice} onChange={(e) => editConfig({ hosts: draft.hosts.map((h, j) => j === i ? { ...h, voice: e.target.value } : h) })} /></label>
              </div>)}</div>
              <p style={{ fontSize: 14, color: 'var(--text-secondary)' }}>Voice names must match a voice supported by your Gemini text-to-speech model. After saving a new voice or model, use “Check the key again” above to test recording.</p>
              <details style={{ marginTop: 20, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                <summary style={{ minHeight: 44, cursor: 'pointer', fontSize: 14 }}>Advanced model and content settings</summary>
                <div style={grid}>
                  {draft.model !== undefined && <label style={{ fontSize: 14 }}>Gemini text-to-speech model<input style={field} required value={draft.model} onChange={(e) => editConfig({ model: e.target.value })} /></label>}
                  {[['sheetsPerRun', 'New cheat sheets per recording', 0], ['topicsPerEpisode', 'Interview topics per episode', 1], ['algorithmTopics', 'Algorithm topics within that total', 0]].filter(([key]) => draft[key] !== undefined).map(([key, label, min]) => <label key={key} style={{ fontSize: 14 }}>{label}<input type="number" min={min} max="20" step="1" required style={field} value={draft[key]} onChange={(e) => editConfig({ [key]: e.target.value })} /></label>)}
                </div>
              </details>
              <button type="submit" className="btn btn-primary" style={{ ...control, marginTop: 16 }} disabled={!pending.current.config}>{busy === 'config' ? 'Saving preferences…' : 'Save podcast preferences'}</button>
            </fieldset>
          </form>
          {(pending.current.config || pending.current.schedule) && <button type="button" className="btn btn-secondary" style={control} disabled={!!busy || loading} onClick={discard}>Discard unsaved podcast changes</button>}
        </>}
      </section>
    );
  }

  window.DailyDrop = DailyDrop;
  window.DailyDropOnboarding = DailyDropOnboarding;
  window.DailyDropSetupCard = DailyDropSetupCard;
})();
