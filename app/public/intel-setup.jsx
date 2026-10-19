/* global React */
(() => {
  const {useState,useEffect,useRef}=React;
  const request=async(url,method,body)=>{const res=await fetch(url,{method:method||'GET',...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const value=await res.json();if(!res.ok)throw new Error(value.error||'Intel settings could not load.');return value;};
  function scheduleLabel(cron){const p=cron.split(' ');if(p.length!==5||p[2]!=='*'||p[3]!=='*')return cron;const clock=`${p[1].padStart(2,'0')}:${p[0].padStart(2,'0')}`;return `${p[4]==='*'?'Daily':p[4]==='1-5'||p[4]==='1,2,3,4,5'?'Weekdays':`Days ${p[4]}`} at ${clock}`;}
  function IntelSetup({active = true, configureRequest = 0}) {
    const heading=useRef(null), configuredRequest=useRef(0);
    const [data,setData]=useState(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[frequency,setFrequency]=useState('weekdays'),[time,setTime]=useState('07:03');
    const load=async()=>{try{const value=await request('/api/intel-control');setData(value);setError('');return value;}catch(e){setError(e.message);return null;}};
    useEffect(()=>{let active=true;request('/api/intel-control').then(value=>{if(!active)return;setData(value);const p=value.schedule.cron?.split(' ');if(p?.length===5){setTime(`${p[1].padStart(2,'0')}:${p[0].padStart(2,'0')}`);setFrequency(p[4]==='*'?'daily':p[4]==='1-5'||p[4]==='1,2,3,4,5'?'weekdays':'custom');}else setFrequency('off');}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
    useEffect(()=>{if(!data?.running)return;const timer=setTimeout(load,3000);return()=>clearTimeout(timer);},[data]);
    useEffect(()=>{if(!active||!data||!configureRequest||configuredRequest.current===configureRequest||!heading.current)return;configuredRequest.current=configureRequest;heading.current.scrollIntoView({block:'start'});heading.current.focus({preventScroll:true});},[active,data,configureRequest]);
    const act=async(fn)=>{setBusy(true);setError('');setMessage('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}};
    return <section aria-labelledby="intel-setup-heading" className="card intel-setup">
      <style>{`.intel-setup{padding:20px}.intel-setup h2{font-size:18px;margin-bottom:12px}.intel-setup p{font-size:14px;line-height:1.6;margin:10px 0;color:var(--text-secondary)}.intel-setup .intel-actions,.intel-setup .intel-fields{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin:12px 0}.intel-setup label{font-size:14px;color:var(--text);display:block}.intel-setup select,.intel-setup input{display:block;width:100%;min-height:44px;font:inherit;font-size:16px;margin-top:6px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface);color:var(--text);color-scheme:dark}.intel-setup .btn{min-height:44px}.intel-setup .intel-schedule{border-top:1px solid var(--border);margin-top:16px;padding-top:12px}.intel-setup [role=alert]{color:var(--rose)}.intel-setup .intel-warning{color:var(--amber)}.intel-setup [role=status]{color:var(--text-secondary)}.intel-setup :focus-visible{outline:2px solid var(--cyan);outline-offset:3px}@media(max-width:430px){.intel-setup{padding:16px}.intel-setup .intel-fields label{flex:1 1 130px}.intel-setup .intel-fields .btn{width:100%}}`}</style><h2 id="intel-setup-heading" ref={heading} tabIndex={-1}>Intel runs</h2>
      <p >Find public roles and prepare daily quizzes and tasks using your configured AI runtime. Existing daily content and saved decisions are preserved.</p>
      {!data&&!error&&<p role="status">Loading Intel settings…</p>}
      {data&&<>
        <p >Runtime: {data.runtime.displayName || 'Not configured'} · {data.runtime.ready?'ready':'needs setup'}</p>
        {!data.runtime.ready&&<p className="intel-warning">{data.runtime.error || 'Complete Job Quest setup in your agent chat first.'}</p>}
        <div className="intel-actions"><button className="btn btn-primary" disabled={busy||data.running||!data.runtime.ready} onClick={()=>act(async()=>{await request('/api/intel-control/run','POST');setMessage('Intel run started. You can leave this page while it works.');await load();})}>{data.running?'Intel running…':'Run Intel now'}</button><button className="btn btn-secondary" disabled={busy} onClick={load}>Check run status</button></div>
        {data.lastRun?<p role="status" className={data.lastRun.status==='failed'||data.lastRun.status==='unknown'?'intel-warning':undefined}>Last run{data.lastRun.trigger?` (${data.lastRun.trigger==='dashboard'?'started here':data.lastRun.trigger})`:''}: <strong>{data.lastRun.status}</strong>{data.lastRun.finishedAt?` · ${new Date(data.lastRun.finishedAt).toLocaleString()}`:''}{data.lastRun.summary&&data.lastRun.status==='completed'?` · ${data.lastRun.summary}`:''}{data.lastRun.reason?` · ${data.lastRun.reason}`:''}</p>
          :data.run&&<p  role="status">Last requested run: {data.run.status}{data.run.finishedAt?` · ${new Date(data.run.finishedAt).toLocaleString()}`:''}. {data.run.error||''}</p>}
        <p >Newest intel: {data.latestIntelDate?new Date(`${data.latestIntelDate}T12:00:00`).toLocaleDateString():'none yet'}{data.outputs.intel?' (today’s discovery is done)':''}</p>
        <div className="intel-schedule">
          <p >Native Intel schedule: {data.schedule.installed?scheduleLabel(data.schedule.cron):'off'} · {data.timeZone}</p>
          {data.schedule.error&&<p className="intel-warning">{data.schedule.error}</p>}
          <div className="intel-fields"><label >Frequency<select  value={frequency} onChange={e=>setFrequency(e.target.value)}>{frequency==='custom'&&<option value="custom">Current custom schedule</option>}<option value="off">Off — run manually</option><option value="weekdays">Weekdays</option><option value="daily">Daily</option></select></label>{frequency!=='off'&&<label >Local time<input type="time"  value={time} onChange={e=>setTime(e.target.value)}/></label>}<button className="btn btn-secondary" disabled={busy||frequency==='custom'||(frequency!=='off'&&!data.runtime.ready)} onClick={()=>act(async()=>{const value=await request('/api/intel-control/schedule','PUT',{frequency,time});setData(value);setMessage(frequency==='off'?'Native Intel schedule removed.':'Native Intel schedule saved.');})}>Save Intel schedule</button></div>
          <p >Scheduled runs need this Mac awake and online. This schedules the collector, not automatic dashboard startup.</p>
          {data.outreachOwner==='external'&&<p >Your existing career review owns inbox collection. Native Intel runs keep that review in place and skip a second inbox scan.</p>}
        </div>
      </>}
      {error&&<p  role="alert">{error}</p>}{message&&<p  role="status">{message}</p>}
    </section>;
  }
  window.IntelSetup=IntelSetup;
})();
