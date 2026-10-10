/* Dashboard overview: sourced next steps, then progress. */
window.dashboardHighlights = function(items, nativeRoles = [], roleActions = {}, roleTracker = {}) {
  const dueOutreach = window.filterJobQuestCards ? window.filterJobQuestCards(items || [], 'outreach', false) : [];
  const eligible = (items || []).filter(item => {
    if (item.queueOnly || item.status?.startsWith('hold') || ['declined','awaiting_recruiter','meeting_booked','sent','applied'].includes(item.status)) return false;
    if (item.kind === 'recruiter') return dueOutreach.some(card => card.id === item.id);
    const role = window.matchJobQuestOutreachRole?.(item, nativeRoles);
    const key = role && `${role.company}|${role.role}`;
    const stage = key && roleTracker[key]?.stage;
    return !key || (!(roleActions.applied || []).includes(key) && !(roleActions.skipped || []).includes(key)
      && !['applied','phone-screen','onsite','offer','rejected'].includes(stage));
  });
  const recent = list => list.sort((a,b) => (b.checkedAt || '').localeCompare(a.checkedAt || ''));
  const contacts = recent(eligible.filter(i => i.kind === 'recruiter'));
  const jobs = recent(eligible.filter(i => i.kind === 'job'));
  return [...contacts.slice(0,2), ...jobs.slice(0, contacts.length ? 1 : 3), ...contacts.slice(2), ...jobs.slice(1)].filter((x,i,a) => a.findIndex(y=>y.id===x.id)===i).slice(0,3);
};
window.DashboardHome = function({todayTasks, setPage, progress = {}, jobStatus, nativeRoles = [], roleActions = {}, roleTracker = {}, onOpenRole}) {
  const {useState,useEffect} = React;
  const [profile,setProfile] = useState(null), [brief,setBrief] = useState(null), [practice,setPractice] = useState(null), [error,setError] = useState('');
  useEffect(() => {
    let live = true;
    fetch('/api/learning').then(r=>r.ok?r.json():Promise.reject()).then(v=>{if(live)setPractice(v);}).catch(()=>{});
    fetch('/api/profile').then(r=>r.ok?r.json():Promise.reject()).then(v=>{if(live)setProfile(v);}).catch(()=>{});
    const load = () => fetch('/api/opportunities').then(r=>r.ok?r.json():Promise.reject()).then(v=>{if(live){setBrief(v);setError('');}}).catch(()=>{if(live)setError('Could not load saved opportunities. Open Outreach to retry.');});
    load(); const timer = setInterval(load,30000);
    return () => {live=false;clearInterval(timer);};
  },[]);
  const date = new Date(), hour = date.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const today = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  const pending = (todayTasks?.tasks || []).filter(t=>!t.completed), next = pending.find(t=>t.minutes>5)||pending[0];
  const continuation = practice?.choices?.find(c=>c.saved && c.href);
  const highlights = window.dashboardHighlights(brief?.opportunities, nativeRoles, roleActions, roleTracker);
  const checked = value => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleDateString(undefined,{month:'short',day:'numeric'}) : 'date unknown';
  return <div className="dashboard-home">
    <style>{`
      .dashboard-home .page-header{margin-bottom:24px}.dashboard-home h3{font-size:21px;margin:0 0 14px}.dashboard-home .dashboard-section{margin-bottom:28px}
      .dashboard-home .section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}.dashboard-home .section-head h3{margin:0}
      .dashboard-home .continue-practice{padding:18px 22px;margin-bottom:12px}.dashboard-home .continue-practice h4{font-size:20px;line-height:1.35;margin:5px 0 8px}.dashboard-home .continue-practice .section-label{font-size:14px;margin:0}
      .dashboard-home .headline-list{border-top:1px solid var(--border)}.dashboard-home .headline{padding:16px 0;border-bottom:1px solid var(--border);display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center}
      .dashboard-home .headline h4{font-size:17px;line-height:1.4;margin:4px 0}.dashboard-home .headline p{font-size:14px;color:var(--text-secondary);margin:5px 0;max-width:70ch}.dashboard-home .meta{font-size:13px;color:var(--text-muted)}
      .dashboard-home .headline a{display:inline-flex;align-items:center;min-height:44px}.dashboard-home .headline-actions{display:flex;gap:12px;flex-wrap:wrap}.dashboard-home .stats-row{margin:12px 0}.dashboard-home .stat-card .value{font-size:26px}.dashboard-home .stat-card .label{font-size:14px;text-transform:none;letter-spacing:0}
      .dashboard-home .secondary-copy{color:var(--text-secondary);font-size:14px}.dashboard-home summary{min-height:44px}
      @media(max-width:600px){.dashboard-home .headline{grid-template-columns:1fr;gap:2px}.dashboard-home .continue-practice{padding:16px}.dashboard-home .stats-row{display:grid;grid-template-columns:1fr 1fr}.dashboard-home .section-head .btn{font-size:14px}}
    `}</style>
    <header className="page-header"><h2>{greeting}{profile?.name ? `, ${profile.name.split(' ')[0]}` : ''}.</h2><p className="greeting-sub">{date.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'})} · Your next steps, in one place.</p></header>
    <section className="dashboard-section" aria-labelledby="dashboard-today"><h3 id="dashboard-today">Today</h3>
      <div className="continue-practice"><div><p className="section-label">{continuation?'Your saved practice':todayTasks?.date===today?'Your practice plan':todayTasks?.date?`Continue your plan from ${todayTasks.date}`:'Practice at your pace'}</p><h4>{continuation?.title||next?.text||'Choose something useful to practice'}</h4><p>{(continuation||next)?'Pick up your saved exercise, or choose a shorter session.':'Coding, system design, behavioral practice and concept review.'}</p></div>{continuation?<a className="btn btn-primary" href={continuation.href}>Continue practice</a>:<button className="btn btn-primary" onClick={()=>setPage(next?'tasks':'practice')}>{next?'Continue practice':'Choose practice'}</button>}</div>
      <div className="quick-budgets" aria-label="Practice time">{[5,15,30].map(n=><a key={n} href="#practice" onClick={e=>{e.preventDefault();sessionStorage.setItem('jq-practice-minutes',String(n));window.dispatchEvent(new CustomEvent('jq-practice-budget',{detail:n}));setPage('practice');}}><strong>{n} minutes</strong><span>{n===5?'Recall a concept':n===15?'Focus on one exercise':'Work through a session'}</span></a>)}</div>
    </section>
    <section className="dashboard-section" aria-labelledby="dashboard-opportunities"><div className="section-head"><h3 id="dashboard-opportunities">Jobs & recruiter contacts</h3><div className="headline-actions"><button className="btn btn-secondary" onClick={()=>setPage('opportunities')}>Recruiter outreach</button><button className="btn btn-secondary" onClick={()=>setPage('discover')}>Discover jobs</button></div></div>
      <p className="secondary-copy">From your saved review{brief?.generatedAt?` · updated ${checked(brief.generatedAt)}`:''}. Check the source for current availability.</p>
      {error?<p role="alert">{error}</p>:!brief?<p role="status">Loading opportunities…</p>:!highlights.length?<p>No active opportunities in the saved review yet.</p>:<div className="headline-list">{highlights.map(item=><article className="headline" key={item.id}><div><div className="meta">{item.kind==='recruiter'?'Recruiter contact':'Job listing'} · checked {checked(item.checkedAt)}</div><h4>{item.company} · {item.title}</h4>{item.fit&&<p>{item.fit}</p>}</div><div className="headline-actions">{onOpenRole && window.matchJobQuestOutreachRole?.(item,nativeRoles) && <button className="btn btn-secondary" onClick={()=>onOpenRole(window.matchJobQuestOutreachRole(item,nativeRoles))}>Open role &amp; prep</button>}{item.sourceLinks?.[0]&&<a href={item.sourceLinks[0]} target="_blank" rel="noopener noreferrer">{item.kind==='recruiter'?'Open conversation':'Open listing'}</a>}{item.schedulingUrl&&<a href={item.schedulingUrl} target="_blank" rel="noopener noreferrer">Recruiter calendar</a>}</div></article>)}</div>}
    </section>
    <div className="today-links"><button className="card" onClick={()=>setPage('learn')}><h3>Learn on the go</h3><p>Continue a resource and save your place.</p><span>Open learning plan</span></button><button className="card" onClick={()=>setPage('resume')}><h3>Your resume</h3><p>Review your original and editable master.</p><span>Open resume</span></button></div>
    <section className="dashboard-section" aria-labelledby="dashboard-progress"><h3 id="dashboard-progress">Progress</h3><div className="stats-row"><div className="stat-card"><div className="value">{progress.streak||0}</div><div className="label">Day streak</div></div><div className="stat-card"><div className="value">{progress.completedTasks||0}/{progress.totalTasks||0}</div><div className="label">Tasks done</div></div><div className="stat-card"><div className="value">{progress.totalQuestions?`${Math.round(progress.correctAnswers/progress.totalQuestions*100)}%`:'—'}</div><div className="label">Quiz accuracy</div></div><div className="stat-card"><div className="value">{progress.daysActive||0}</div><div className="label">Days active</div></div></div><button className="btn btn-secondary" onClick={()=>setPage('calendar')}>View progress & calendar</button></section>
    <details className="card"><summary>Plan history & review status</summary><p className="secondary-copy">{pending.length} unfinished tasks in {todayTasks?.date||'your current plan'}. Imported completions remain historical progress.</p><p className="secondary-copy">Opportunity review: {brief?.generatedAt?checked(brief.generatedAt):'not available'}. Native daily run: {jobStatus?.status?.replaceAll('_',' ')||'status unavailable'}. {jobStatus?.reviewSource?.mode==='external'?' External career review is configured; its last checked sources appear in Outreach.':''} Review scheduling and connections in Setup.</p><div className="action-row"><button className="btn btn-secondary" onClick={()=>setPage('workbooks')}>Open workbooks</button><button className="btn btn-secondary" onClick={()=>setPage('setup')}>Open setup</button></div></details>
  </div>;
};
