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

  const openOnboarding = () => window.dispatchEvent(new CustomEvent('jq:daily-drop-setup'));

  // The key is only "connected" once Google has actually returned audio for it. Until then the fix is shown here.
  const keyProblem = (state) => state.hasKey && !(state.key && state.key.verified) ? state.key || { message: 'This key has not been checked yet.', remediation: '' } : null;

  function SetupPrompt({ state }) {
    const missing = [!state.hasKey && 'voices', !(state.schedule && state.schedule.installed) && 'morning schedule'].filter(Boolean);
    const problem = keyProblem(state);
    if (!missing.length && !problem) return null;
    return (
      <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14, color: 'var(--text-secondary)', flex: 1, minWidth: 240 }}>
          {missing.length > 0 && <div>Daily Drop still needs its {missing.join(' and ')}.</div>}
          {problem && <div role="alert" style={{ color: 'var(--rose)', marginTop: missing.length ? 6 : 0 }}>{problem.code === 'unchecked' ? "The saved Gemini key hasn't been tested yet. Check it in the Voices card below." : "The saved Gemini key can't record audio yet. Fix it in the Voices card below."}</div>}
        </div>
        <button className="btn btn-primary" onClick={openOnboarding}>Set up Daily Drop</button>
      </div>
    );
  }

  // Manage the Gemini key here: see whether it works, replace it, check it again or remove it.
  // The key itself never comes back from the server; only its last four characters do.
  function VoicesCard({ state, reload }) {
    const [editing, setEditing] = useState(false), [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [note, setNote] = useState('');
    const key = state.key || { verified: false, code: 'no-key', source: 'none' };
    const verdict = (r) => (r.key.verified ? 'Voices connected.' : `${r.key.message} ${r.key.remediation}`);
    const run = async (fn) => { setBusy(true); setNote(''); try { await fn(); } catch (e) { setNote(e.message); } finally { setBusy(false); reload(); } };
    const save = () => run(async () => { const r = await req('/api/podcast/config', 'PUT', { apiKey: draft }); setDraft(''); setEditing(false); setNote(verdict(r)); });
    const check = () => run(async () => setNote(verdict(await req('/api/podcast/key/verify', 'POST'))));
    const remove = () => { if (window.confirm('Remove the saved Gemini key? Episodes stop until a new one is added.')) run(async () => { await req('/api/podcast/key', 'DELETE'); setNote('Key removed.'); }); };
    const when = key.checkedAt ? new Date(key.checkedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
    return (
      <div className="card" aria-label="Voices">
        <div className="card-title" style={{ fontWeight: 600, marginBottom: 8 }}>Voices</div>
        {!state.hasKey && <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 0 }}>No Gemini key saved. The hosts need one to record. Create it at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">aistudio.google.com/apikey</a>; a short test recording checks it before anything else runs.</p>}
        {state.hasKey && key.verified && <p role="status" style={{ fontSize: 14, color: 'var(--emerald)', marginTop: 0 }}>Connected. Key {key.hint}{key.source === 'env' ? ' from GEMINI_API_KEY' : ''}{when ? `, checked ${when}` : ''}.</p>}
        {state.hasKey && !key.verified && <p role="alert" style={{ fontSize: 14, color: 'var(--rose)', marginTop: 0, lineHeight: 1.5 }}>Key {key.hint} can't record audio. {key.message} {key.remediation}</p>}
        {editing && <label style={{ fontSize: 14, display: 'block', marginBottom: 10 }}>New Gemini API key<input type="password" autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Paste key" style={field} /></label>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {editing
            ? <>
                <button className="btn btn-primary" disabled={busy || !draft.trim()} onClick={save}>{busy ? 'Testing…' : 'Save and test'}</button>
                <button className="btn btn-secondary" disabled={busy} onClick={() => { setEditing(false); setDraft(''); }}>Cancel</button>
              </>
            : <button className="btn btn-primary" disabled={busy || key.source === 'env'} onClick={() => setEditing(true)}>{state.hasKey ? 'Replace key' : 'Add key'}</button>}
          {state.hasKey && !editing && <button className="btn btn-secondary" disabled={busy} onClick={check}>{busy ? 'Checking…' : 'Check the key again'}</button>}
          {state.hasKey && !editing && key.source !== 'env' && <button className="btn btn-secondary" disabled={busy} onClick={remove}>Remove key</button>}
        </div>
        {key.source === 'env' && <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 10 }}>This key is set by the GEMINI_API_KEY environment variable, so it can only be changed there.</p>}
        {note && <div role="status" style={{ fontSize: 13, marginTop: 10, color: 'var(--text-secondary)' }}>{note}</div>}
      </div>
    );
  }

  function Today({ state, reload }) {
    const [sel, setSel] = useState(null), [script, setScript] = useState(null), [showScript, setShowScript] = useState(false), [note, setNote] = useState('');
    const eps = state.episodes || [];
    const ep = eps.find((e) => e.date === sel) || eps[0];
    useEffect(() => { setScript(null); setShowScript(false); }, [ep && ep.date]);
    const loadScript = async () => { if (!script) setScript(await req(`/api/podcast/episodes/${ep.date}/script`)); setShowScript((v) => !v); };
    const generate = async () => { setNote(''); try { await req('/api/podcast/generate', 'POST', { force: true, deliver: false }); setNote('Making a fresh episode. This takes a few minutes.'); reload(); } catch (e) { setNote(e.message); } };
    const fuzzy = async (c) => { await req('/api/podcast/fuzzy', 'POST', { id: c.id }); setNote(`"${c.title}" will come back tomorrow.`); };
    const busy = state.running || (ep && ep.status === 'building');
    return (
      <div>
        <SetupPrompt state={state} />
        <div className="card">
          {!ep && <p style={{ color: 'var(--text-secondary)' }}>No episodes yet. The first one arrives at {String(state.config.hour).padStart(2, '0')}:{String(state.config.minute).padStart(2, '0')}, or make one now.</p>}
          {ep && (
            <>
              <div style={{ fontSize: 12, color: 'var(--amber)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: 1 }}>{pretty(ep.date)}{ep.seconds ? ` · ${mins(ep.seconds)}` : ''}</div>
              <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 24, margin: '6px 0 4px', color: 'var(--text)', textTransform: 'none', letterSpacing: 0 }}>{ep.title || 'Episode in progress'}</h3>
              {ep.summary && <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>{ep.summary}</p>}
              {ep.status === 'ready' && <audio controls preload="metadata" src={`/api/podcast/episodes/${ep.date}/audio`} style={{ width: '100%', margin: '8px 0 12px' }} />}
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
            <button className="btn btn-secondary" disabled={busy || !(state.key && state.key.verified)} title={state.key && state.key.verified ? undefined : 'Connect a working Gemini key first'} onClick={generate}>{busy ? 'Making episode…' : 'Make a new episode now'}</button>
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
        <VoicesCard state={state} reload={reload} />
        {eps.length > 1 && (
          <div className="card">
            <div className="card-title" style={{ fontWeight: 600, marginBottom: 8 }}>Past episodes</div>
            {eps.map((e) => (
              <button key={e.date} onClick={() => setSel(e.date)} className="btn btn-secondary" style={{ display: 'flex', width: '100%', justifyContent: 'space-between', marginBottom: 6, textAlign: 'left', borderColor: ep && e.date === ep.date ? 'var(--amber)' : undefined }}>
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
          <button className="btn btn-secondary" disabled={busy} onClick={refresh}>{busy ? 'Ranking…' : 'Re-rank now'}</button>
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
          <div className="greeting-sub">A short lesson each morning on the concepts your upcoming interviews are most likely to ask, ranked across your roles' workbooks.</div>
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
    const [key, setKey] = useState(''), [time, setTime] = useState('08:30'), [imessage, setImessage] = useState(true);
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [done, setDone] = useState('');
    const dialog = useRef(null);
    const load = async () => { const v = await req('/api/podcast/onboarding'); setInfo(v); setImessage(v.config.imessage !== false); if (v.schedule.time) setTime(v.schedule.time); return v; };
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
              <button className="btn btn-primary" disabled={busy} onClick={next}>Set it up</button>
              <button className="btn btn-secondary" disabled={busy} onClick={() => close('later')}>Not now</button>
              <button className="btn btn-secondary" disabled={busy} onClick={() => close('skip')}>No thanks</button>
            </>}
            {step === 'voices' && <>
              <button className="btn btn-primary" disabled={busy || (!key.trim() && !info.hasKey)} onClick={() => act(async () => {
                // Saving runs a short test recording. A key that cannot record stays on this step with the fix shown.
                const r = key.trim() ? await req('/api/podcast/config', 'PUT', { apiKey: key }) : { key: info.key };
                setKey('');
                const v = await load();
                if (!(r.key && r.key.verified) && !(v.key && v.key.verified)) throw new Error(`${r.key ? r.key.message : ''} ${r.key ? r.key.remediation : ''}`.trim());
                next();
              })}>{key.trim() ? 'Save and test' : 'Continue'}</button>
              {info.hasKey && !info.key.verified && <button className="btn btn-secondary" disabled={busy} onClick={() => act(async () => { const r = await req('/api/podcast/key/verify', 'POST'); await load(); if (!r.key.verified) throw new Error(`${r.key.message} ${r.key.remediation}`.trim()); next(); })}>Check the key again</button>}
              <button className="btn btn-secondary" disabled={busy} onClick={back}>Back</button>
              <button className="btn btn-secondary" disabled={busy} onClick={next}>Skip this step</button>
            </>}
            {step === 'schedule' && <>
              <button className="btn btn-primary" disabled={busy} onClick={() => act(async () => { await req('/api/podcast/config', 'PUT', { imessage: imessage && info.imessageAvailable }); await req('/api/podcast/schedule', 'PUT', { time }); await req('/api/podcast/onboarding', 'POST', { action: 'done' }); await load(); setDone('You are set'); next(); })}>Schedule it</button>
              <button className="btn btn-secondary" disabled={busy} onClick={back}>Back</button>
              <button className="btn btn-secondary" disabled={busy} onClick={() => act(async () => { await req('/api/podcast/onboarding', 'POST', { action: 'done' }); setDone('Set up without a schedule'); next(); })}>Skip, I'll make episodes by hand</button>
            </>}
            {step === 'finish' && <>
              <button className="btn btn-primary" disabled={busy || !info.key.verified} onClick={() => act(async () => { await req('/api/podcast/generate', 'POST', { force: true, deliver: true }); setOpen(false); if (setPage) setPage('dailydrop'); })}>Make my first episode now</button>
              <button className="btn btn-secondary" disabled={busy} onClick={() => setOpen(false)}>I'll wait</button>
            </>}
          </div>
          {!info.key.verified && step === 'finish' && <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 10 }}>{info.hasKey ? `The saved Gemini key can't record audio yet. ${info.key.remediation}` : 'Add a Gemini key on the Daily Drop page before the first episode can be recorded.'}</p>}
        </div>
      </div>
    );
  }

  // Compact entry on the Setup page so a skipped onboarding is easy to come back to.
  function DailyDropSetupCard() {
    const [info, setInfo] = useState(null);
    useEffect(() => { req('/api/podcast/onboarding').then(setInfo).catch(() => {}); }, []);
    const ready = info && info.key && info.key.verified && info.schedule.installed;
    return (
      <section className="card" aria-label="Daily Drop podcast">
        <h3>Daily Drop podcast</h3>
        <p>{!info ? 'Checking…' : ready ? `On. A new episode every day at ${info.schedule.time}.` : info.state.status === 'skipped' ? 'Off. You turned down the setup; you can still turn it on.' : 'Optional. A short daily two-host episode on what you need to remember.'}</p>
        <button className="btn btn-secondary" onClick={openOnboarding}>{ready ? 'Change Daily Drop settings' : 'Set up Daily Drop'}</button>
      </section>
    );
  }

  window.DailyDrop = DailyDrop;
  window.DailyDropOnboarding = DailyDropOnboarding;
  window.DailyDropSetupCard = DailyDropSetupCard;
})();
