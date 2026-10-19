/* global React */
(() => {
  const {useState,useEffect,useRef}=React;
  const sections=[['intel','Intel'],['podcast','Podcasts'],['practice','Practice preferences'],['access','Runtime & access']];
  const route=id=>id==='intel'?'setup':`setup-${id}`;
  const request=async(url,method='GET',body)=>{const r=await fetch(url,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const v=await r.json();if(!r.ok)throw Error(v.error||'Settings could not be loaded.');return v;};
  function PracticePreferences({active}) {
    const [saved,setSaved]=useState(null),[draft,setDraft]=useState(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
    const dirty=useRef(false),generation=useRef(0),saving=useRef(false);
    const load=async()=>{if(saving.current)return;const current=++generation.current;try{const v=await request('/api/settings');if(current!==generation.current)return;setSaved(v);if(!dirty.current)setDraft(v);setError('');}catch(e){if(current===generation.current)setError(e.message);}};
    useEffect(()=>{if(active)load();},[active]);
    const change=(group,key,value)=>{dirty.current=true;setMessage('');setDraft(old=>({...old,[group]:{...old[group],[key]:value}}));};
    return <><section className="card" aria-labelledby="automatic-prep-heading"><h2 id="automatic-prep-heading">Automatic preparation</h2><p>Choose what Job Quest prepares when you save or apply to a role. These jobs use your configured AI provider.</p>
      {!draft&&!error&&<p role="status">Loading preparation settings…</p>}
      {draft&&<form onSubmit={async e=>{e.preventDefault();generation.current++;saving.current=true;setBusy(true);setError('');setMessage('');try{const value=await request('/api/settings','PUT',{workbooks:{autoBuild:draft.workbooks.autoBuild,autoDailyCap:Number(draft.workbooks.autoDailyCap)},resume:{autoTailor:draft.resume.autoTailor,autoDailyCap:Number(draft.resume.autoDailyCap)}});setSaved(value);setDraft(value);dirty.current=false;setMessage('Preparation preferences saved.');}catch(e){setError(e.message);}finally{saving.current=false;setBusy(false);}}}>
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
  function RuntimeChecks({active}) {
    const [diagnostics,setDiagnostics]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
    const generation=useRef(0);
    const load=async()=>{const current=++generation.current;setBusy(true);setError('');try{const value=await request('/api/runtime/diagnostics');if(current===generation.current)setDiagnostics(value);}catch(e){if(current===generation.current)setError(e.message);}finally{if(current===generation.current)setBusy(false);}};
    useEffect(()=>{if(active)load();},[active]);
    const ready=entry=>entry.node.ok&&entry.runtime.ok&&(diagnostics.runtime.id!=='codex'||entry.runtime.login.ready===true);
    const loginText=login=>login.ready===true?'Signed in':login.ready===false?'Sign-in needed':login.status==='not_checked'?'Sign-in not checked':'Sign-in could not be confirmed';
    return <section className="card" aria-labelledby="runtime-checks-heading"><h2 id="runtime-checks-heading">Node & AI runtime</h2>
      <p>Check the tools Job Quest can find for Intel, coaching and preparation. Gemini audio is configured under Podcasts.</p>
      <button className="btn btn-secondary" disabled={busy} onClick={load}>{busy?'Checking tools…':'Refresh runtime checks'}</button>
      {error&&<p role="alert">{error}</p>}
      {busy&&<p role="status">Checking installed tools and local sign-in status…</p>}
      {diagnostics&&<div aria-busy={busy}>{[['dashboard','Dashboard'],['scheduled','Scheduled jobs — environment check']].map(([key,label])=>{const entry=diagnostics[key];return <div className="setup-runtime-result" key={key}><h3>{label}</h3><p><strong>{ready(entry)?'Tools available':'Needs attention'}</strong> · Node {entry.node.version||'unavailable'} · {diagnostics.runtime.displayName} {entry.runtime.version||'unavailable'} · {loginText(entry.runtime.login)}</p>
        {[entry.node.error,entry.runtime.error,entry.runtime.login.error].filter(Boolean).map((message,index)=><p key={index}>{message}</p>)}
        {entry.runtime.login.ready===false&&<p>Open your terminal, run <code>codex login</code>, then refresh these checks.</p>}
        {entry.simulated&&<p className="setup-hint">This simulates the scheduled job’s tool search. See Intel for the latest actual run.</p>}
        <details><summary>Installation details</summary><dl><dt>Node executable</dt><dd><code>{entry.node.path||'Not found'}</code></dd><dt>{diagnostics.runtime.displayName} executable</dt><dd><code>{entry.runtime.path||'Not found'}</code></dd></dl></details>
      </div>;})}
      {diagnostics.dashboard.runtime.path&&diagnostics.scheduled.runtime.path&&diagnostics.dashboard.runtime.path!==diagnostics.scheduled.runtime.path&&<p>These environments find different copies of {diagnostics.runtime.displayName}. Both are checked above.</p>}</div>}
      <p>To install a missing tool or change AI runtimes, ask your Job Quest agent. These checks do not generate content or verify a model request.</p>
    </section>;
  }
  function LocalAccess({active}) {
    const [setup,setSetup]=useState(null),[error,setError]=useState('');
    const load=async()=>{try{setSetup(await request('/api/local-setup'));setError('');}catch(e){setError(e.message);}};
    useEffect(()=>{if(active)load();},[active]);
    return <><RuntimeChecks active={active}/>{error&&<p role="alert">{error} <button className="btn btn-secondary" onClick={load}>Try again</button></p>}<section className="card"><h2>Use on this Mac</h2><p>Available at localhost:3847. Your saved work stays on this Mac. Requested AI coaching uses your selected provider.</p></section><section className="card"><h2>Private phone access</h2><p>{!setup?'Checking private access…':setup.privateAuthenticated?'Connected through your private Tailscale link.':setup.privateConfigured?'Your private link is configured. Open it from your phone with Tailscale connected.':'Local-only mode. Private phone access is optional.'}</p><p>Use Tailscale on both devices with the same personal account. This Mac must stay awake and online.</p>{setup?.privateConfigured&&setup?.privateOrigin&&<p><a className="btn btn-secondary" href={setup.privateOrigin+'/#dashboard'}>Open private Job Quest</a></p>}<div className="setup-actions"><a href="https://tailscale.com/download/mac" target="_blank" rel="noopener noreferrer">Tailscale for Mac</a><a href="https://tailscale.com/download/ios" target="_blank" rel="noopener noreferrer">Tailscale for iPhone</a></div></section><details className="card"><summary>Advanced local connections</summary><p>Ask Job Quest to configure a local review source or private Tailscale origin. Saving a connection does not enable network access by itself.</p><code>~/.job-quest/bin/configure-local.cjs --help</code></details></>;
  }
  function JobQuestSetup({active,section='intel',intelConfigureRequest,setPage}) {
    const accountsRequest=useRef(0),previousSection=useRef(null);if(active&&section==='accounts'&&previousSection.current!=='accounts')accountsRequest.current++;if(active)previousSection.current=section;
    const currentSection=section==='accounts'?'intel':section;
    const visited=useRef(new Set());if(active)visited.current.add(currentSection);
    return <div className="setup-page"><header className="page-header"><h1>Setup</h1><p className="greeting-sub">Connections, schedules and preferences in one place.</p></header><nav className="setup-sections section-tabs" aria-label="Setup sections">{sections.map(([id,label])=><a key={id} href={`#${route(id)}`} aria-current={id===currentSection?'page':undefined} onClick={e=>{e.preventDefault();setPage(route(id));}}>{label}</a>)}</nav>
      {visited.current.has('intel')&&<div hidden={currentSection!=='intel'}><window.IntelSetup active={active&&currentSection==='intel'} configureRequest={intelConfigureRequest} sourceConfigureRequest={accountsRequest.current} setPage={setPage}/></div>}
      {visited.current.has('podcast')&&<div hidden={section!=='podcast'}><window.DailyDropSetupCard active={active&&section==='podcast'}/></div>}
      {visited.current.has('practice')&&<div hidden={section!=='practice'}><PracticePreferences active={active&&section==='practice'}/></div>}
      {visited.current.has('access')&&<div hidden={section!=='access'}><LocalAccess active={active&&section==='access'}/></div>}
    </div>;
  }
  window.JobQuestSetup=JobQuestSetup;
})();
