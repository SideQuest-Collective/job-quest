/* global React */
// Loaded as a Babel script beside index.html; deliberately reuses native practice URLs.
(() => {
  const { useState, useEffect } = React;
  const request = async (url, body) => {
    const res = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const value = await res.json();
    if (!res.ok) throw new Error(value.error || 'Could not save. Try again.');
    return value;
  };
  const newId = () => `practice_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const base = { id: 'builtin:hashing', title: 'Hash-table retrieval', content: 'A hash table maps a key to a bucket using a hash function. Collisions occur when different keys map to the same bucket; chaining or probing resolves them. Expected lookup can be O(1) under suitable hashing and load, but worst-case lookup can be O(n). Sorting is useful when ordered iteration or range queries matter.' };
  const practiceCheck = { id: 'builtin:practice-check', title: 'Practice planning and retrieval', content: 'State the inputs and expected output, clarify constraints, work through a small example, and explain how you would check the result. A short reflection is preparation, not proof that the full exercise is solved.' };
  const blankSource = { kind: 'concept', path: '', title: '', content: '', roleKey: '' };
  function practiceGroups(data, minutes) {
    const suggestions = data?.recommendations?.[minutes] || [];
    const primary = suggestions.filter(r => r.feedbackAttemptId || r.conceptRecall);
    const planning = suggestions.filter(r => r.kind !== 'native' && !r.feedbackAttemptId && !r.conceptRecall);
    const native = new Map();
    const candidates = [...(data?.choices || []).filter(c => c.saved || c.planId || c.date || c.minutes <= minutes), ...suggestions.filter(r => r.kind === 'native').map(r => ({...r,minutes:r.suggestedMinutes}))];
    for (const c of candidates.slice().sort((a,b) => Number(!!b.saved)-Number(!!a.saved))) {
      const key = c.href.startsWith('/#') ? c.id : c.href;
      if (!native.has(key)) native.set(key,c);
    }
    return {native:[...native.values()].slice(0,3),primary:primary.slice(0,3),planning:planning.slice(0,3)};
  }
  function planningTitle(r) {
    return (r.planContext?.title || r.title).replace(/^(?:Optional\s+(?:(?:short|planning|5-minute)\s+)?rep:\s*)+/i,'');
  }
  function Learning({ mode = 'practice' }) {
    const cacheKey = `jq-learning-draft-${mode}`;
    const domId = (id) => `${mode}-${id}`;
    const [data, setData] = useState(null), [error, setError] = useState(''), [status, setStatus] = useState('');
    const [busy, setBusy] = useState(false), [minutes, setMinutes] = useState(() => { try { const n=Number(sessionStorage.getItem('jq-practice-minutes')); return [5,15,30].includes(n) ? n : 5; } catch { return 5; } }), [sourceId, setSourceId] = useState(base.id);
    const [feedback, setFeedback] = useState({}), [feedbackError, setFeedbackError] = useState('');
    const [session, setSession] = useState(() => { try { return JSON.parse(sessionStorage.getItem(cacheKey)) || null; } catch { return null; } });
    const [sourceForm, setSourceForm] = useState({ ...blankSource }), [confirmRefresh, setConfirmRefresh] = useState(false), [player, setPlayer] = useState(false);
    const reload = async () => { try { const next = await request('/api/learning'); setData(next); setConfirmRefresh(false); setError(''); } catch (e) { setError(e.message); } };
    useEffect(() => { reload(); }, []);
    useEffect(() => { const update = (e) => { const n=Number(e.detail?.minutes ?? e.detail); if ([5,15,30].includes(n)) setMinutes(n); }; window.addEventListener('jq-practice-budget',update); return () => window.removeEventListener('jq-practice-budget',update); }, []);
    useEffect(() => {
      let active=true;
      request('/api/feedback').then((r) => {if(active) setFeedback(Object.fromEntries((r.attempts || []).filter((a)=>a.source==='learning').map((a)=>[a.id,a])));}).catch(()=>{if(active) setFeedbackError('Saved feedback could not load. Your answers remain available.');});
      return () => {active=false;};
    }, []);
    useEffect(() => {
      const pending=Object.values(feedback).filter((a)=>['queued','running'].includes(a.status)); if(!pending.length)return;
      let active=true;
      const timer=setTimeout(async()=>{ for(const a of pending){try{const r=await request(`/api/feedback/${a.id}`);if(active){setFeedback((old)=>({...old,[a.id]:r.attempt}));setFeedbackError('');if(r.attempt.status==='done')reload();}}catch{if(active)setFeedbackError('Could not refresh feedback. Use Check feedback to reconnect.');}} },3000);
      return ()=>{active=false;clearTimeout(timer);};
    }, [feedback]);
    useEffect(() => { try { if (session) sessionStorage.setItem(cacheKey, JSON.stringify(session)); else sessionStorage.removeItem(cacheKey); } catch {} }, [session, cacheKey]);
    const save = async (url, value, message) => {
      setBusy(true); setError(''); setStatus('');
      try { const next = await request(url, { revision: data.revision, ...value }); setData((old) => ({ ...old, ...next })); setStatus(message); return next; }
      catch (e) { setError(e.message); return null; }
      finally { setBusy(false); }
    };
    useEffect(() => { try { sessionStorage.setItem('jq-practice-minutes', String(minutes)); } catch {} }, [minutes]);
    const start = (reference, kind = 'retrieval', activity = reference) => {
      if (session && !window.confirm('Start another activity? Your current text stays in this browser until replaced. Choose Cancel and Save draft first to keep it in your library.')) return;
      setPlayer(false); setStatus('');
      setSession({ id: newId(), kind, minutes, status: 'draft', response: '', sourceId: reference.id,
        planContext: activity.planContext || null,
        goal: activity.goal || `Explain ${reference.title} from memory, then check one gap.`,
        prompt: activity.prompt || activity.reflection || (reference.id === base.id ? 'A service repeatedly looks up a user by ID. Explain why a hash table may help, what happens when two keys collide, and one case where you would choose an ordered structure.' : `Explain “${reference.title}” from memory. Give a concrete example and one trade-off or limitation.`),
        referenceContent: reference.content || '', sourceOrigin: reference.linked ? 'linked' : 'saved', sourceHash: reference.sha256 || null, assisted: !!activity.planContext?.feedbackAttemptId, revealed: false, positionSeconds: 0 });
    };
    const storeSession = async (answered) => {
      const next = await save('/api/learning/session', { session: { ...session, status: answered ? 'answered' : 'draft' } }, answered ? 'Answer saved as ungraded evidence. No mastery score was assigned.' : 'Draft and position saved.');
      if (next && answered) setSession(null);
    };
    const review = async (s, retry = false) => {
      setBusy(true);setFeedbackError('');
      const m=s.mediaSnapshot || data.media.find((item)=>item.id===s.sourceId);
      const question=s.kind==='media' ? `${s.prompt}\nEvaluation scope: written reflection only. Resource content and consumption are not verified. Do not grade whether the user understood, watched or listened to the resource. Evaluate the reasoning in their answer against their stated goal. Resource metadata: ${JSON.stringify({title:m?.title,url:m?.url,goal:s.goal})}` : s.prompt;
      try { const r=await request(retry ? `/api/feedback/${s.id}/retry` : '/api/evaluate-answer', retry ? {} : {key:`learning_${s.id}`,attemptId:s.id,question,userAnswer:s.response,category:s.kind==='media'?'written reflection only':'concept recall',sampleAnswer:s.sourceSnapshot?.content || (s.sourceId===base.id?base.content:''),source:'learning',assistance:{assisted:s.assisted,revealed:s.revealed,sourceId:s.sourceId,sourceHash:s.sourceSnapshot?.sha256 || null,planContext:s.planContext || null,...(s.kind==='media'?{consumptionVerified:false,sourceContentVerified:false}:{})}});setFeedback((old)=>({...old,[s.id]:r.attempt})); }
      catch(e){setFeedbackError(e.message);}finally{setBusy(false);}
    };
    const refreshFeedback = async () => { try { const r=await request('/api/feedback');setFeedback(Object.fromEntries((r.attempts || []).filter((a)=>a.source==='learning').map((a)=>[a.id,a])));setFeedbackError(''); await reload(); } catch(e){setFeedbackError(e.message);} };
    const resume = (item) => {
      if (session && !window.confirm('Replace the current editor with this saved draft? Save the current draft first if you need to keep it.')) return;
      const source = data.sources.find((s) => s.id === item.sourceId);
      setSession({ ...item, referenceContent: item.sourceSnapshot?.content || source?.content || (item.sourceId === base.id ? base.content : '') }); setPlayer(false); setStatus('');
    };
    const existingSource = data?.sources.find((s) => s.id === `${sourceForm.kind}:${sourceForm.path.trim().replace(/\\/g, '/')}`);
    const linkedSources = data?.linkedSources || [];
    const linkedFormSource = linkedSources.find((s) => s.id === `${sourceForm.kind}:${sourceForm.path.trim().replace(/\\/g, '/')}`);
    const selectedReference = sourceId === base.id ? base : sourceId.startsWith('linked:') ? linkedSources.find((s) => `linked:${s.id}` === sourceId) : data?.sources.find((s) => s.id === sourceId);
    const edited = existingSource && (existingSource.content !== sourceForm.content);
    const groups = practiceGroups(data, minutes);
    const startSuggestion = (r) => { const ref = r.reference.id === base.id ? base : r.reference.id === practiceCheck.id ? practiceCheck : r.reference; start(ref, 'retrieval', r); };
    const media = session && data?.media.find((m) => m.id === session.sourceId);
    return <div className="learning-page">
      <style>{`
        .learning-page{max-width:1050px;margin:0 auto;padding-bottom:48px;line-height:1.6;overflow-wrap:anywhere}
        .learning-page h2{font-size:26px;line-height:1.3;margin:0 0 8px}.learning-page h3{font-size:19px;margin:0 0 8px}
        .learning-page p{color:var(--text-secondary);margin:8px 0 16px;font-size:15px}
        .learning-page .lp-card{border:1px solid var(--border);border-radius:14px;background:var(--bg-card);padding:20px;margin:16px 0}
        .learning-page .lp-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.learning-page .lp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:14px}
        .learning-page .lp-grid .lp-card{margin:0}.learning-page button,.learning-page .lp-link{min-height:44px;font:inherit;font-size:15px;border:1px solid var(--border);border-radius:8px;padding:9px 14px;background:var(--bg-surface);color:var(--text-primary);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}
        .learning-page button[aria-pressed=true],.learning-page .lp-primary{border-color:var(--cyan);background:var(--cyan-dim);color:var(--cyan)}
        .learning-page button:disabled{opacity:.55;cursor:not-allowed}.learning-page :focus-visible{outline:3px solid var(--cyan);outline-offset:3px}
        .learning-page label{display:block;font-size:15px;margin:12px 0 5px}.learning-page input:not([type=checkbox]),.learning-page textarea,.learning-page select{width:100%;box-sizing:border-box;min-height:44px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-deep);color:var(--text-primary);font:inherit;font-size:16px}
        .learning-page textarea{resize:vertical;min-height:140px}.learning-page input[type=checkbox]{width:20px;height:20px;vertical-align:middle;margin-right:8px}.learning-page summary{cursor:pointer;padding:10px 0;font-size:16px}.learning-page .lp-note{font-size:14px;color:var(--text-secondary)}
        .learning-page pre{white-space:pre-wrap;font:inherit;font-size:15px;max-height:300px;overflow:auto}.learning-page audio{width:100%;margin-top:12px}.learning-page iframe{width:100%;aspect-ratio:16/9;border:0;border-radius:8px}.learning-page .lp-error{border-left:4px solid var(--rose);padding:12px;background:var(--bg-card)}
        @media(max-width:420px){.learning-page .lp-card{padding:15px}.learning-page h2{font-size:24px}.learning-page .lp-row>*{max-width:100%}}
      `}</style>
      <h2>{mode === 'learn' ? 'Learn on the go' : 'A little practice, right now'}</h2>
      <p>{mode === 'learn' ? 'Choose a resource, keep your place, and turn one idea into an answer.' : 'Choose your time. Continue unfinished work or try a short recall exercise.'}</p>
      {error && <div role="alert" className="lp-error"><p>{error}</p><button onClick={reload} disabled={busy}>Reload saved data</button><p className="lp-note">Your open answer and source form stay here when you reload.</p></div>}
      {status && <p role="status">{status}</p>}
      {!data ? <p role="status">{error ? 'Learning is unavailable until the data loads.' : 'Loading your practice…'}</p> : <>
        <div className="lp-row" role="group" aria-label="Available time">{[5, 15, 30].map((m) => <button key={m} aria-pressed={minutes === m} onClick={() => setMinutes(m)}>{m} minutes</button>)}</div>
        <p className="lp-note">{minutes === 5 ? '1 min recall · 3 min answer · 1 min check' : minutes === 15 ? '2 min recall · 10 min practice or listen · 3 min reflect' : '5 min plan · 20 min practice or listen · 5 min review'}. A time budget is a stopping point, not a claim that the whole problem fits.</p>
        {session && <section className="lp-card" aria-label="Current activity">
          <h3>{session.kind === 'media' ? 'Listen or watch, then reflect' : session.sourceId === practiceCheck.id ? 'A short planning or follow-up rep' : 'Recall before revealing'}</h3><p>{session.goal}</p><p className="lp-note">This activity: {session.minutes} minutes. Text is kept in this browser until saved to your library.</p>
          {session.planContext && <div><p className="lp-note">For: {session.planContext.title}{session.planContext.feedbackAttemptId ? ' · follow-up to a reviewed answer' : ''}</p>{session.planContext.href && <a className="lp-link" href={session.planContext.href}>Open full practice →</a>}<p className="lp-note">This reflection is an optional preparation step. Full practice remains available before reading or watching anything here.</p></div>}
          {media && <><a className="lp-link" href={media.url} target="_blank" rel="noopener noreferrer">Open {media.publisher} resource ↗</a>
            {media.youtubeId && <div style={{marginTop:12}}>{player ? <><iframe title={media.title} src={`https://www.youtube-nocookie.com/embed/${media.youtubeId}?start=${Math.floor(session.positionSeconds || 0)}`} allow="encrypted-media; picture-in-picture" allowFullScreen /><p className="lp-note">If the video is blocked or unavailable, use Open resource above. Your draft stays here.</p></> : <button onClick={() => setPlayer(true)}>Load video here</button>}</div>}
            {media.audioUrl && <audio key={session.id} aria-label={media.title} controls preload="none" src={media.audioUrl} onLoadedMetadata={(e)=>{e.currentTarget.currentTime=session.positionSeconds || 0;}} onTimeUpdate={(e)=>{const at=Math.floor(e.currentTarget.currentTime);if(Math.abs(at-session.positionSeconds)>=5)setSession((old)=>({...old,positionSeconds:at}));}} onPause={(e)=>{const at=Math.floor(e.currentTarget.currentTime);setSession((old)=>({...old,positionSeconds:at}));}} onError={()=>setError('The audio could not load. Open the publisher resource above, then save your position here.')} />}
            <label htmlFor={domId('lp-position')}>Bookmark position (seconds)</label><input id={domId('lp-position')} type="number" min="0" max="86400" value={session.positionSeconds} onChange={(e) => setSession({...session, positionSeconds: Number(e.target.value)})}/><p className="lp-note">{media.audioUrl ? 'The local player updates this bookmark. Save draft & position to keep it in your library.' : 'Set your stopping point and save. Playback on external sites does not update this bookmark automatically.'}</p>
          </>}
          <label htmlFor={domId('lp-answer')}>{session.prompt}</label><textarea id={domId('lp-answer')} value={session.response} onChange={(e) => setSession({...session, response:e.target.value})} placeholder="Write what you can explain without the reference…"/>
          {session.sourceOrigin === 'linked' && <p className="lp-note">Using the shared interview reference. Saving checks its current hash; the saved attempt keeps this exact snapshot.</p>}
          {session.kind === 'retrieval' && <><button style={{marginTop:12}} onClick={() => setSession({...session, revealed:true})}>Reveal reference</button>{session.revealed && <pre>{session.referenceContent || 'This saved draft has no reference snapshot. Reopen its source before relying on it.'}</pre>}</>}
          <label><input type="checkbox" disabled={!!session.planContext?.feedbackAttemptId} checked={session.assisted} onChange={(e) => setSession({...session, assisted:e.target.checked})}/>I used help while answering</label>
          {session.planContext?.feedbackAttemptId && <p className="lp-note">This rep uses a coach-provided follow-up. That assistance stays attached to the answer.</p>}
          {session.revealed && <p className="lp-note">Reference revealed; this context will stay attached to the answer.</p>}
          <div className="lp-row"><button disabled={busy} onClick={() => storeSession(false)}>Save draft &amp; position</button><button className="lp-primary" disabled={busy || !session.response.trim()} onClick={() => storeSession(true)}>Save answer</button><button disabled={busy} onClick={() => { if (window.confirm('Close this editor? Any unsaved changes will be discarded. Saved drafts remain in your library.')) setSession(null); }}>Close</button></div>
          <p className="lp-note">Save your answer first, then request AI feedback in Saved answers. Reviews use the same coach as native practice and retain help/reveal context.</p>
        </section>}
        {mode === 'practice' && <>
          <section className="lp-card" aria-label="Native practice"><h3>{groups.native.some(c => c.saved) ? 'Continue saved work' : 'Continue your practice'}</h3>
            {groups.native.length > 0 ? <div className="lp-grid">{groups.native.map(c => <article key={c.id}><h3>{c.title}</h3><p>{c.reason}</p><a className="lp-link lp-primary" href={c.href}>Open {c.href.startsWith('/workbooks/') ? 'workbook' : c.href.startsWith('/?problem=') ? 'Code Lab' : c.href.startsWith('/?sd=') ? 'system design' : 'practice'} →</a>{c.minutes > minutes && <p className="lp-note">Start with a {minutes}-minute focus, then save a stopping point. The full task may take longer.</p>}</article>)}</div> : <p>Choose a practice tool below, or start a concept recall.</p>}
            <div className="lp-row" style={{marginTop:16}}><a className="lp-link" href="/#codelab">Code Lab</a><a className="lp-link" href="/#sysdesign">System design</a><a className="lp-link" href="/#behavioral">Behavioral</a><a className="lp-link" href="/#workbooks">Workbooks</a></div>
          </section>
          <section className="lp-card" aria-label="Concept recall"><h3>Recall a concept</h3><p>Explain one idea from memory, then reveal the reference and check a gap. Choose a shared concept or use hash-table retrieval.</p>
            <label htmlFor={domId('lp-concept')}>Concept</label><select id={domId('lp-concept')} value={sourceId} onChange={(e) => setSourceId(e.target.value)}><option value={base.id}>{base.title}</option>{linkedSources.length>0&&<optgroup label="Shared with interview preparation">{linkedSources.map((s)=><option key={s.id} value={`linked:${s.id}`}>{s.title}</option>)}</optgroup>}{data.sources.some((s)=>s.kind==='concept')&&<optgroup label="Saved learning snapshots">{data.sources.filter((s) => s.kind === 'concept').map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</optgroup>}</select><button className="lp-primary" style={{marginTop:12}} disabled={busy || !selectedReference} onClick={() => start(selectedReference)}>Start {minutes}-minute recall</button>
          </section>
          {groups.primary.length > 0 && <section className="lp-card" aria-label="Suggested practice"><h3>For your next rep</h3><div className="lp-grid">{groups.primary.map(r => <article key={r.id}><h3>{r.title}</h3><p>{r.reason}</p><div className="lp-row">{r.planContext?.href && <a className="lp-link" href={r.planContext.href}>Open full practice first →</a>}<button disabled={busy} className="lp-primary" onClick={() => startSuggestion(r)}>Start {minutes}-minute {r.feedbackAttemptId ? 'follow-up' : 'recall'}</button></div></article>)}</div></section>}
          {groups.planning.length > 0 && <details className="lp-card"><summary>Optional planning before practice</summary><p className="lp-note">Clarify a goal and an example before the full task. These planning questions do not test whether you can solve it.</p><div className="lp-grid">{groups.planning.map(r => <article key={r.id}><h3>{planningTitle(r)}</h3><p>{r.reason}</p><div className="lp-row">{r.planContext?.href && <a className="lp-link" href={r.planContext.href}>Open full practice first →</a>}<button disabled={busy} onClick={() => startSuggestion(r)}>Plan for {minutes} minutes</button></div></article>)}</div></details>}
          {data.warnings.map((w) => <p role="status" key={w}>{w}</p>)}
        </>}
        {data.sessions.some((s) => s.status === 'draft') && <section className="lp-card"><h3>Resume a saved learning rep</h3>{data.sessions.filter((s) => s.status === 'draft').slice().reverse().slice(0,5).map((s) => <div key={s.id} style={{marginBottom:12}}><p>{s.goal}</p><button disabled={busy} onClick={() => resume(s)}>Resume {s.minutes}-minute {s.kind === 'media' ? 'reflection' : 'recall'}</button></div>)}</section>}
        {(data.recommendationWarnings || []).map((w) => <p role="status" key={w}>{w}</p>)}
        {(mode === 'learn' || data.media.some(m => m.matched)) && <section className="lp-card"><h3>{mode === 'learn' ? 'Learn, then apply' : 'A resource for your next practice'}</h3><div className="lp-grid">{data.media.filter(m => mode === 'learn' || m.matched).map((m) => <article key={m.id}><div className="lp-note">{m.kind === 'audio' ? 'Listen' : 'Watch'} · {m.publisher}</div><h3>{m.title}</h3><p>{m.goal}</p><p className="lp-note">{m.planContext.reason}</p><button className="lp-primary" disabled={busy} onClick={() => start(m,'media')}>Start {minutes}-minute learning rep</button><p className="lp-note">Use part of your budget for a segment, then write the reflection. Playback does not mark this goal complete.</p><a className="lp-link" href={m.planContext.href}>Follow up: {m.planContext.title} →</a><p className="lp-note"><a href={m.url} target="_blank" rel="noopener noreferrer">Source ↗</a> · Link checked {m.checkedAt}</p></article>)}</div></section>}
        <details className="lp-card"><summary>Shared reference library · {linkedSources.length} linked · {data.sources.length} saved</summary><p>Keep concepts, resumes, stories and company preparation distinct. References create no practice credit. Shared concepts read the same owned source as interview preparation; saved learning snapshots stay separate. Nothing here changes an active interview selection.</p>
          <h3>Shared with interview preparation</h3><button disabled={busy} onClick={reload}>Refresh linked references</button>
          {(data.linkedWarnings || []).map((w,i)=><p role="status" key={i}>{w}</p>)}
          {data.linkedAvailable && !linkedSources.length && <p>No conceptual sheets are linked in interview preparation yet. Saved references below still work.</p>}
          {linkedSources.map((s)=><article key={s.id} style={{borderBottom:'1px solid var(--border)',padding:'12px 0'}}><strong>{s.title}</strong><p className="lp-note">Shared concept · current owned source</p>{(data.linkedConflicts || []).some((c)=>c.id===s.id)&&<p role="status">Your saved learning snapshot differs from this shared source. Choose the shared reference or the saved snapshot explicitly; neither has been replaced.</p>}<button disabled={busy} onClick={()=>{setSourceId(`linked:${s.id}`);start(s);}}>Practice this shared reference</button><details><summary>Read source and identity</summary><pre>{s.content}</pre><p className="lp-note">{s.id}<br/>{s.resolvedPath}<br/>SHA-256: {s.sha256}</p></details></article>)}
          <h3 style={{marginTop:20}}>Saved learning snapshots</h3>
          {data.importableCount > 0 && <div><button disabled={busy} onClick={() => save('/api/learning/import-existing', {}, 'Existing references added. Previously saved snapshots were preserved.')}>Add existing local references ({data.importableCount})</button><p className="lp-note">Imports your local concept library. Story paths stay classified as stories; existing snapshots are never replaced.</p></div>}
          {data.sources.map((s) => <article key={s.id} style={{borderBottom:'1px solid var(--border)',padding:'12px 0'}}><strong>{s.title}</strong><p className="lp-note">{s.kind} · {s.path}{s.roleKey ? ` · ${s.roleKey}` : ''}</p><button onClick={() => { setSourceForm({...s}); setConfirmRefresh(false); }}>Review or refresh source</button><details><summary>Snapshot and identity</summary><pre>{s.content}</pre><p className="lp-note">{s.id}<br/>SHA-256: {s.sha256}</p></details></article>)}
          <form onSubmit={async (e) => { e.preventDefault(); const next = await save('/api/learning/sources', {source:sourceForm, confirmRefresh, previousHash:existingSource?.sha256}, 'Reference saved. Existing answers and interview selections were preserved.'); if(next){setSourceForm({...blankSource});setConfirmRefresh(false);} }}>
            <h3 style={{marginTop:20}}>{existingSource ? 'Refresh this snapshot' : 'Add a reference'}</h3>
            <label htmlFor={domId('lp-kind')}>Kind</label><select id={domId('lp-kind')} value={sourceForm.kind} onChange={(e) => setSourceForm({...sourceForm,kind:e.target.value})}>{['concept','resume','story','company'].map((k) => <option key={k}>{k}</option>)}</select>
            <label htmlFor={domId('lp-title')}>Title</label><input id={domId('lp-title')} required maxLength={300} value={sourceForm.title} onChange={(e) => setSourceForm({...sourceForm,title:e.target.value})}/>
            <label htmlFor={domId('lp-path')}>Stable source path</label><input id={domId('lp-path')} required maxLength={500} placeholder="resources/cheatsheets/my-topic.md" value={sourceForm.path} onChange={(e) => { setSourceForm({...sourceForm,path:e.target.value});setConfirmRefresh(false); }}/><p className="lp-note">Use the same source path as interview preparation for a shared identity. This field labels your pasted snapshot; it does not read a file or change the HUD.</p>
            {linkedFormSource && <p role="status">This identity also has a shared interview source. Saving here creates or updates a separate learning snapshot; edit the owned source file to change the shared reference.</p>}
            {sourceForm.kind === 'company' && <><label htmlFor={domId('lp-role')}>Company|Role</label><input id={domId('lp-role')} required value={sourceForm.roleKey || ''} onChange={(e) => setSourceForm({...sourceForm,roleKey:e.target.value})}/></>}
            <label htmlFor={domId('lp-content')}>Reference content</label><textarea id={domId('lp-content')} required maxLength={100000} value={sourceForm.content} onChange={(e) => {setSourceForm({...sourceForm,content:e.target.value});setConfirmRefresh(false);}}/>
            {edited && <div><p role="status">The saved snapshot differs. Review it above before replacing it.</p><label><input type="checkbox" checked={confirmRefresh} onChange={(e) => setConfirmRefresh(e.target.checked)}/>Replace this reference snapshot; preserve earlier attempts</label></div>}
            <div className="lp-row" style={{marginTop:12}}><button className="lp-primary" disabled={busy || (edited && !confirmRefresh)}>Save reference</button><button type="button" onClick={() => {setSourceForm({...blankSource});setConfirmRefresh(false);}}>Clear form</button></div>
          </form>
        </details>
        <details className="lp-card"><summary>Saved answers · {data.sessions.filter((s) => s.status === 'answered').length}</summary>
          {feedbackError && <p role="alert">{feedbackError}</p>}<button onClick={refreshFeedback} disabled={busy}>Check feedback</button>
          {data.sessions.filter((s) => s.status === 'answered').slice().reverse().map((s) => {const f=feedback[s.id];return <article key={s.id} style={{marginTop:20,borderTop:'1px solid var(--border)',paddingTop:16}}><h3>{s.goal}</h3><p className="lp-note">{new Date(s.updatedAt).toLocaleString()} · {s.assisted ? 'Help used' : 'No help reported'} · {s.revealed ? 'Reference revealed' : 'Reference not revealed'}</p><pre>{s.response}</pre>{s.planContext?.href && <a className="lp-link" href={s.planContext.href}>Continue: {s.planContext.title} →</a>}
            {!f && <><p className="lp-note">Ungraded evidence</p><button disabled={busy} onClick={()=>review(s)}>Request AI feedback</button></>}
            {f && ['queued','running'].includes(f.status) && <p role="status">Feedback {f.status === 'queued' ? 'queued' : 'in progress'}. Your answer is saved; you can leave this page.</p>}
            {f?.status === 'failed' && <div><p role="alert">{f.error || 'Feedback failed. Your answer is preserved; no score was assigned.'}</p><button disabled={busy} onClick={()=>review(s,true)}>Retry feedback</button></div>}
            {f?.status === 'done' && f.evaluation && <div><p><strong>{f.evaluation.score}/{f.evaluation.maxScore}</strong> · AI feedback for this {s.kind==='media'?'written reflection':'answer'}</p>{s.kind==='media'&&<p className="lp-note">This reviews your reasoning. It does not verify resource consumption or comprehension.</p>}<p>{f.evaluation.feedback}</p>{f.evaluation.strengths?.length>0&&<><strong>What worked</strong><ul>{f.evaluation.strengths.map((v,i)=><li key={i}>{v}</li>)}</ul></>}{f.evaluation.improvements?.length>0&&<><strong>Improve next</strong><ul>{f.evaluation.improvements.map((v,i)=><li key={i}>{v}</li>)}</ul></>}{f.evaluation.nextRep&&<p><strong>Next practice:</strong> {f.evaluation.nextRep}</p>}</div>}
          </article>;})}
          {!data.sessions.some((s) => s.status === 'answered') && <p>No answers yet. Reading or importing a source does not count as an attempt.</p>}</details>
      </>}
    </div>;
  }
  window.Learning = Learning;
})();
