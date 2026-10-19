/* global React */
(() => {
  const {useState,useEffect,useRef}=React;
  const sections=[['intel','Intel'],['podcast','Podcasts'],['accounts','Accounts & sources'],['practice','Practice preferences'],['access','Local access']];
  const route=id=>id==='intel'?'setup':`setup-${id}`;
  const request=async(url,method='GET',body)=>{const r=await fetch(url,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const v=await r.json();if(!r.ok)throw Error(v.error||'Settings could not be loaded.');return v;};
  function PracticePreferences({active}) {
    const [saved,setSaved]=useState(null),[draft,setDraft]=useState(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
    const dirty=useRef(false);
    const load=async()=>{try{const v=await request('/api/settings');setSaved(v);if(!dirty.current)setDraft(v);setError('');}catch(e){setError(e.message);}};
    useEffect(()=>{if(active)load();},[active]);
    const change=(group,key,value)=>{dirty.current=true;setMessage('');setDraft(old=>({...old,[group]:{...old[group],[key]:value}}));};
    return <><section className="card" aria-labelledby="automatic-prep-heading"><h2 id="automatic-prep-heading">Automatic preparation</h2><p>Choose what Job Quest prepares when you save or apply to a role. These jobs use your configured AI provider.</p>
      {!draft&&!error&&<p role="status">Loading preparation settings…</p>}
      {draft&&<form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');setMessage('');try{const value=await request('/api/settings','PUT',{workbooks:{autoBuild:draft.workbooks.autoBuild,autoDailyCap:Number(draft.workbooks.autoDailyCap)},resume:{autoTailor:draft.resume.autoTailor,autoDailyCap:Number(draft.resume.autoDailyCap)}});setSaved(value);setDraft(value);dirty.current=false;setMessage('Preparation preferences saved.');}catch(e){setError(e.message);}finally{setBusy(false);}}}>
        <fieldset disabled={busy} className="setup-form-fields"><div className="setup-fields">{[['workbooks','autoBuild','Build workbooks'],['resume','autoTailor','Tailor resumes']].map(([group,key,label])=><fieldset key={group}><legend>{label}</legend><label className="setup-check"><input type="checkbox" checked={!!draft[group][key]} onChange={e=>change(group,key,e.target.checked)}/>Automatically for saved and applied roles</label><label>Daily limit<input type="number" min="0" max="100" required value={draft[group].autoDailyCap} onChange={e=>change(group,'autoDailyCap',e.target.value)}/></label></fieldset>)}</div>
        <div className="setup-actions"><button className="btn btn-primary" disabled={busy||!dirty.current}>{busy?'Saving…':'Save preparation preferences'}</button><button type="button" className="btn btn-secondary" disabled={busy||!dirty.current} onClick={()=>{setDraft(saved);dirty.current=false;setMessage('Unsaved changes discarded.');}}>Discard changes</button></div>
      </fieldset></form>}{error&&<p role="alert">{error} <button className="btn btn-secondary" onClick={load}>Try again</button></p>}{message&&<p role="status">{message}</p>}
    </section><window.ContentReadiness/><TrainerPreferences active={active}/></>;
  }
  function TrainerPreferences({active}) {
    const [config,setConfig]=useState(undefined),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
    const load=async()=>{try{const v=await request('/api/trainer/questions');setConfig(v.config);setError('');}catch(e){setError(e.message);}};
    useEffect(()=>{if(active)load();},[active]);
    return <section className="card"><h2>Interview trainer</h2><p>Practice reminders and Daily Drop delivery use the Trainer’s iMessage recipient.</p>{config===undefined&&!error?<p role="status">Checking trainer configuration…</p>:config?<><p>Reminders are {config.enabled?'enabled':'paused'}. Configured hours: {config.startHour??9}:00–{config.endHour??21}:00. Recipient: {config.phone||'not set'}.</p><button className="btn btn-secondary" disabled={busy} onClick={async()=>{setBusy(true);try{const v=await request('/api/trainer/config','POST',{enabled:!config.enabled});setConfig(v.config);setMessage(v.config.enabled?'Reminders enabled for the existing schedule.':'Reminders paused.');setError('');}catch(e){setError(e.message);}finally{setBusy(false);}}}>{config.enabled?'Pause trainer reminders':'Resume trainer reminders'}</button></>:<p>No trainer is configured.</p>}<p>To install or change the reminder schedule or recipient, ask your Job Quest agent to configure the interview trainer. It also checks the Messages permissions this Mac needs.</p>{error&&<p role="alert">{error} <button className="btn btn-secondary" onClick={load}>Try again</button></p>}{message&&<p role="status">{message}</p>}</section>;
  }
  function LocalAccess({active}) {
    const [setup,setSetup]=useState(null),[runtime,setRuntime]=useState(null),[error,setError]=useState('');
    const load=async()=>{try{const [s,r]=await Promise.all([request('/api/local-setup'),request('/api/runtime')]);setSetup(s);setRuntime(r);setError('');}catch(e){setError(e.message);}};
    useEffect(()=>{if(active)load();},[active]);
    return <>{error&&<p role="alert">{error} <button className="btn btn-secondary" onClick={load}>Try again</button></p>}<section className="card"><h2>AI runtime</h2>{runtime?<><p>{runtime.displayName}: {runtime.validation?.status==='ready'?'available':'needs attention'}.</p><p>Intel, coaching and preparation use this runtime. Gemini is configured separately under Podcasts for audio.</p><p>To change the runtime, ask your Job Quest agent to switch between Codex and Claude and verify the connection.</p></>:<p role="status">Checking runtime…</p>}</section><section className="card"><h2>Use on this Mac</h2><p>Available at localhost:3847. Your saved work stays on this Mac. Requested AI coaching uses your selected provider.</p></section><section className="card"><h2>Private phone access</h2><p>{!setup?'Checking private access…':setup.privateAuthenticated?'Connected through your private Tailscale link.':setup.privateConfigured?'Your private link is configured. Open it from your phone with Tailscale connected.':'Local-only mode. Private phone access is optional.'}</p><p>Use Tailscale on both devices with the same personal account. This Mac must stay awake and online.</p>{setup?.privateConfigured&&setup?.privateOrigin&&<p><a className="btn btn-secondary" href={setup.privateOrigin+'/#dashboard'}>Open private Job Quest</a></p>}<div className="setup-actions"><a href="https://tailscale.com/download/mac" target="_blank" rel="noopener noreferrer">Tailscale for Mac</a><a href="https://tailscale.com/download/ios" target="_blank" rel="noopener noreferrer">Tailscale for iPhone</a></div></section><details className="card"><summary>Advanced local connections</summary><p>Ask Job Quest to configure a local review source or private Tailscale origin. Saving a connection does not enable network access by itself.</p><code>~/.job-quest/bin/configure-local.cjs --help</code></details></>;
  }
  function JobQuestSetup({active,section='intel',intelConfigureRequest,setPage}) {
    const visited=useRef(new Set());if(active)visited.current.add(section);
    return <div className="setup-page"><header className="page-header"><h1>Setup</h1><p className="greeting-sub">Connections, schedules and preferences in one place.</p></header><nav className="setup-sections" aria-label="Setup sections">{sections.map(([id,label])=><a key={id} href={`#${route(id)}`} aria-current={id===section?'page':undefined} onClick={e=>{e.preventDefault();setPage(route(id));}}>{label}</a>)}</nav>
      {visited.current.has('intel')&&<div hidden={section!=='intel'}><window.IntelSetup active={active&&section==='intel'} configureRequest={intelConfigureRequest}/></div>}
      {visited.current.has('podcast')&&<div hidden={section!=='podcast'}><window.DailyDropSetupCard active={active&&section==='podcast'}/></div>}
      {visited.current.has('accounts')&&<div hidden={section!=='accounts'}><window.Opportunities configureOnly active={active&&section==='accounts'} setPage={setPage} onConfigureIntel={()=>setPage('setup')}/></div>}
      {visited.current.has('practice')&&<div hidden={section!=='practice'}><PracticePreferences active={active&&section==='practice'}/></div>}
      {visited.current.has('access')&&<div hidden={section!=='access'}><LocalAccess active={active&&section==='access'}/></div>}
    </div>;
  }
  window.JobQuestSetup=JobQuestSetup;
})();
