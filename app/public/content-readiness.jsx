/* global React */
(() => {
 const {useState,useEffect}=React;
 const fields=[['behavioralQuestions','Unanswered behavioral prompts'],['quizQuestions','Recent quiz questions'],['quizTopics','Quiz topic types'],['quizMaxAgeDays','Quiz freshness (days)'],['audioResources','Audio resources'],['videoResources','Video resources'],['mediaPublishers','Media publishers'],['mediaGoals','Different learning goals'],['mediaMaxAgeDays','Media source check age (days)']];
 const request=async(method,body)=>{const r=await fetch('/api/content-readiness'+(method==='PUT'?'/settings':''),{method:method||'GET',...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const v=await r.json();if(!r.ok)throw Error(v.error||'Content readiness could not load.');return v;};
 function ContentReadiness({compact=false}) {
  const [data,setData]=useState(null),[settings,setSettings]=useState({}),[error,setError]=useState(''),[status,setStatus]=useState(''),[busy,setBusy]=useState(false);
  const load=async()=>{try{const v=await request();setData(v);setSettings(v.thresholds);setError('');}catch(e){setError(e.message);}};
  useEffect(()=>{load();},[]);
  const copy=async()=>{try{await navigator.clipboard.writeText('Check Job Quest content readiness, then fill the reported shortages using its existing prep-plan and quiz flows. Preserve all existing tasks, answers, quizzes and progress. For media, add verified public audio/video sources with varied topics and actual source check dates. Report anything that cannot be filled.');setStatus('Request copied. Paste it into your Job Quest agent chat to prepare more content.');}catch{setError('Copy is unavailable. Ask your Job Quest agent chat to check content readiness and fill shortages while preserving your saved work.');}};
  const body=<>
   <p>Checked when Job Quest starts. Keep enough unanswered questions, recent quizzes and varied listening or watching options.</p>
   {!data&&!error&&<p role="status">Checking saved content…</p>}
   {data&&<>
    <div className="readiness-counts"><span>Behavioral: <strong>{data.behavioral.available}/{data.behavioral.minimum}</strong> prompts</span><span>Quiz: <strong>{data.quiz.questions}</strong> questions across <strong>{data.quiz.topics}</strong> topics</span><span>On the go: <strong>{data.media.audio}</strong> audio · <strong>{data.media.video}</strong> video</span></div>
    <p role="status">{data.status==='ready'?'Your content meets these minimums.':data.status==='needs_review'?'Some content could not be checked. Review the details below.':'Some content is running low.'}</p>
    {data.gaps.length>0&&<ul>{data.gaps.map(g=><li key={g.kind}>{g.message}</li>)}</ul>}
    {data.warnings.length>0&&<ul>{data.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul>}
    <div className="readiness-actions"><button className="btn btn-secondary" onClick={load} disabled={busy}>Check content again</button>{data.gaps.length>0&&<button className="btn btn-primary" onClick={copy}>Copy request for more content</button>}</div>
    <p className="readiness-note">Checking does not generate content or verify playback. Intel creates daily quizzes and tasks; it preserves existing daily files. Your agent can add behavioral prompts and verified media without replacing saved work.</p>
    {!compact&&<details><summary>Content minimums</summary><form onSubmit={async e=>{e.preventDefault();setBusy(true);setStatus('');try{const v=await request('PUT',settings);setData(v.readiness||v);setSettings(v.thresholds||(v.readiness||v).thresholds);setError('');setStatus('Content minimums saved.');}catch(err){setError(err.message);}finally{setBusy(false);}}}><div className="readiness-settings">{fields.map(([key,label])=><label key={key}>{label}<input required type="number" min="1" max={key.endsWith('Days')?365:100} value={settings[key]??''} onChange={e=>setSettings({...settings,[key]:Number(e.target.value)})}/></label>)}</div><button className="btn btn-secondary" disabled={busy}>Save content minimums</button></form></details>}
   </>}
   {error&&<p role="alert">{error}</p>}{status&&<p role="status">{status}</p>}
  </>;
  return <section className="card readiness-card" aria-label="Content readiness"><style>{`.readiness-card{line-height:1.6}.readiness-card p{color:var(--text-secondary);margin:10px 0}.readiness-card h3{font-size:19px}.readiness-counts{display:flex;flex-wrap:wrap;gap:8px 24px;margin:16px 0}.readiness-actions{display:flex;flex-wrap:wrap;gap:10px}.readiness-card .readiness-note{font-size:14px}.readiness-card summary{padding:10px 0;cursor:pointer}.readiness-settings{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(230px,100%),1fr));gap:16px;margin:16px 0}.readiness-settings label{display:flex;flex-direction:column;gap:6px}.readiness-settings input{font:inherit;font-size:16px;min-height:44px;max-width:100%;box-sizing:border-box;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-surface);color:var(--text-primary)}`}</style>{compact?<details><summary>Content readiness{data&&!data.ready?' · needs attention':''}</summary>{body}<a href="#setup">Configure content minimums in Setup</a></details>:<><h3>Content readiness</h3>{body}</>}</section>;
 }
 window.ContentReadiness=ContentReadiness;
})();
