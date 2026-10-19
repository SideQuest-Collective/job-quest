/* Dashboard outreach requires current conversation evidence; displaying priorities never changes state. */
window.dashboardPriorities = function({ items = [], nativeRoles = [], roleActions = {}, roleTracker = {}, now = Date.now() } = {}) {
  const timestamp = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null;
    const day = value.slice(0, 10), at = Date.parse(value);
    return Number.isFinite(at) && new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) === day ? at : null;
  };
  const displayDate = value => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const keyFor = role => `${role.company}|${role.role}`;
  const inactive = value => value?.dismissed === true || value?.stale === true || /^(?:hold|declined|dismissed|closed|expired|stale|archived|rejected|withdrawn|cancelled|canceled)/i.test(value?.status || '')
    || /^(?:closed|expired|unavailable|removed)\b/i.test(value?.availability || '');
  const decided = key => ['saved', 'skipped', 'applied'].some(action => (roleActions[action] || []).includes(key))
    || Boolean(roleTracker[key]);
  const roleRecords = new Set();
  const roles = nativeRoles.filter(role => {
    if (!role?.company || !role?.role) return false;
    const identity = `${keyFor(role)}|${role.url || ''}|${role.location || ''}`;
    if (roleRecords.has(identity)) return false;
    roleRecords.add(identity); return true;
  });
  const candidates = [];
  const dateReason = (label, value) => timestamp(value) === null ? '' : ` ${label} ${displayDate(value)}.`;

  // The native prep workflow can record a scheduled interview in the timeline.
  // Require an explicit scheduled/booked/confirmed event and a future stored date.
  // Ingested interview:<folder>
  // records are completed sessions, even if their machine clock was wrong.
  for (const role of roles) {
    const key = keyFor(role), tracker = roleTracker[key] || {};
    if (inactive(role) || inactive(tracker) || ['rejected', 'offer'].includes(tracker.stage) || (roleActions.skipped || []).includes(key)) continue;
    const upcoming = (Array.isArray(tracker.timeline) ? tracker.timeline : []).filter(event => {
      const at = timestamp(event?.date);
      return at !== null && at > now && !String(event.key || '').startsWith('interview:')
        && /\b(?:scheduled|booked|confirmed)\b/i.test(event.event || '')
        && /\b(?:interview|recruiter (?:call|screen)|phone screen|coding (?:round|screen)|system design (?:round|interview)|onsite)\b/i.test(event.event || '')
        && !/\b(?:practice|mock|prep|prepare|not|never|tentative|unconfirmed|unscheduled|cancelled|canceled|completed|finished|debrief|reschedule needed)\b/i.test(event.event || '') && !inactive(event);
    }).sort((a, b) => timestamp(a.date) - timestamp(b.date));
    if (upcoming.length) {
      const event = upcoming[0], at = timestamp(event.date);
      candidates.push({ id: `prep:${key}`, kind: 'interview', role, title: `${role.company} · ${role.role}`, label: 'Prepare for interview', action: 'Open role & prep',
        reason: `${event.event} · ${displayDate(event.date)}. Review this role’s preparation before the recorded interview.`, rank: at - now <= 2 * 86400000 ? 0 : 2, at, identity: `role:${key}` });
    }
  }

  for (const item of items) {
    if (!item?.id || item.kind !== 'recruiter' || inactive(item)) continue;
    const due = timestamp(item.nextReminderAt), isDue = due !== null && due <= now;
    if (['declined', 'meeting_booked', 'applied'].includes(item.status)) continue;
    const inbound = timestamp(item.lastInboundAt), sent = timestamp(item.sentAt);
    const newerInbound = inbound !== null && sent !== null && inbound > sent;
    if (['snoozed', 'reconnect_scheduled'].includes(item.status) && !isDue) continue;
    if (['awaiting_recruiter', 'sent'].includes(item.status) && !isDue && !newerInbound) continue;
    if (due !== null && due > now) continue;
    if (item.queueOnly && !isDue) continue;
    const review = window.jobQuestConversationReview?.(item, now);
    if (review?.outcome !== 'needs_reply') continue;
    const isFollowup = sent !== null && !(inbound !== null && inbound > sent);
    const role = window.matchJobQuestOutreachRole?.(item, roles) || null;
    candidates.push({ id: `outreach:${item.id}`, kind: isFollowup ? 'followup' : 'reply', item, role,
      title: `${item.company || 'Recruiter'} · ${item.title || 'Recruiter outreach'}`, label: isFollowup ? 'Follow up' : 'Respond to recruiter', action: isFollowup ? 'Review follow-up' : 'Review reply',
      reason: `${review.reason} Conversation verified ${displayDate(review.checkedAt)}.`,
      rank: isFollowup ? 1 : 3, at: isFollowup ? (due ?? timestamp(review.checkedAt)) : (inbound ?? timestamp(review.checkedAt)), identity: `outreach:${item.id}` });
  }

  for (const role of roles) {
    const key = keyFor(role);
    if (inactive(role) || inactive(roleTracker[key]) || decided(key)) continue;
    const source = items.find(item => item.kind === 'job' && window.matchJobQuestOutreachRole?.(item, roles) === role);
    if (source && (inactive(source) || ['saved', 'dismissed', 'sent', 'applied'].includes(source.status))) continue;
    candidates.push({ id: `review:${key}`, kind: 'job', role, item: source, title: `${role.company} · ${role.role}`, label: 'Review undecided job', action: 'Review in Discover',
      reason: `You have not saved, dismissed or applied to this role.${dateReason('Discovered', role.intelDate) || dateReason('Source checked', source?.checkedAt)}`,
      rank: 4, at: timestamp(role.intelDate) ?? timestamp(source?.checkedAt) ?? 0, identity: `role:${key}` });
  }
  const seen = new Set(), outreachIds = new Set();
  const unique = candidates.sort((a, b) => a.rank - b.rank || (a.rank === 4 ? b.at - a.at : a.at - b.at) || a.id.localeCompare(b.id)).filter(action => {
    if (seen.has(action.identity)) return false;
    const ids = action.item?.kind === 'recruiter' ? [action.item.id, ...(action.item.relatedIds || [])] : [];
    if (ids.some(id => outreachIds.has(id))) return false;
    seen.add(action.identity); ids.forEach(id => outreachIds.add(id)); return true;
  });
  // Interviews stay first. Share the remaining space between outreach and
  // discoveries so even a backlog of verified follow-ups leaves new jobs visible.
  const interviews = unique.filter(action => action.kind === 'interview');
  const outreach = unique.filter(action => ['followup', 'reply'].includes(action.kind));
  const jobs = unique.filter(action => action.kind === 'job');
  return [...interviews, ...outreach.slice(0, 2), ...jobs, ...outreach.slice(2)].slice(0, 5);
};

window.DashboardHome = function({todayTasks, setPage, progress = {}, jobStatus, nativeRoles = [], roleActions = {}, roleTracker = {}, onOpenRole, onReviewJob, onOpenOutreach}) {
  const {useState,useEffect} = React;
  const [profile,setProfile] = useState(null), [brief,setBrief] = useState(null), [practice,setPractice] = useState(null), [error,setError] = useState('');
  useEffect(() => {
    let live = true;
    fetch('/api/learning').then(r=>r.ok?r.json():Promise.reject()).then(v=>{if(live)setPractice(v);}).catch(()=>{});
    fetch('/api/profile').then(r=>r.ok?r.json():Promise.reject()).then(v=>{if(live)setProfile(v);}).catch(()=>{});
    const load = () => fetch('/api/opportunities').then(r=>r.ok?r.json():Promise.reject()).then(v=>{if(live){setBrief(v);setError('');}}).catch(()=>{if(live)setError('Could not load saved outreach. Open Intel → Outreach to retry.');});
    load(); const timer = setInterval(load,30000);
    return () => {live=false;clearInterval(timer);};
  },[]);
  const date = new Date(), hour = date.getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const today = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  const pending = (todayTasks?.tasks || []).filter(t=>!t.completed), next = pending.find(t=>t.minutes>5)||pending[0];
  const continuation = practice?.choices?.find(c=>c.saved && c.href);
  const priorities = window.dashboardPriorities({items: brief?.opportunities || [], nativeRoles, roleActions, roleTracker, now: date.getTime()});
  const openAction = item => {
    if (item.kind === 'job') return onReviewJob ? onReviewJob(item.role) : setPage('discover');
    if (item.kind === 'interview') return onOpenRole ? onOpenRole(item.role) : setPage('intel');
    return onOpenOutreach ? onOpenOutreach(item.item) : setPage('opportunities');
  };
  const checked = value => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleDateString(undefined,{month:'short',day:'numeric'}) : 'date unknown';
  return <div className="dashboard-home">
    <style>{`
      .dashboard-home .page-header{margin-bottom:24px}.dashboard-home h3{font-size:21px;margin:0 0 14px}.dashboard-home .dashboard-section{margin-bottom:28px}
      .dashboard-home .section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}.dashboard-home .section-head h3{margin:0}
      .dashboard-home .continue-practice{padding:18px 22px;margin-bottom:12px}.dashboard-home .continue-practice h4{font-size:20px;line-height:1.35;margin:5px 0 8px}.dashboard-home .continue-practice .section-label{font-size:14px;margin:0}
      .dashboard-home .headline-list{border-top:1px solid var(--border)}.dashboard-home .headline{padding:16px 0;border-bottom:1px solid var(--border);display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center}
      .dashboard-home .headline h4{font-size:17px;line-height:1.4;margin:4px 0}.dashboard-home .headline p{font-size:14px;color:var(--text-secondary);margin:5px 0;max-width:70ch}.dashboard-home .meta{font-size:13px;color:var(--text-muted)}
      .dashboard-home .headline .btn{min-height:44px;white-space:normal}.dashboard-home .headline a{display:inline-flex;align-items:center;min-height:44px}.dashboard-home .headline-actions{display:flex;gap:12px;flex-wrap:wrap}.dashboard-home .stats-row{margin:12px 0}.dashboard-home .stat-card .value{font-size:26px}.dashboard-home .stat-card .label{font-size:14px;text-transform:none;letter-spacing:0}
      .dashboard-home .secondary-copy{color:var(--text-secondary);font-size:14px}.dashboard-home summary{min-height:44px}.dashboard-home .headline>div{min-width:0}.dashboard-home .headline h4,.dashboard-home .headline p{overflow-wrap:anywhere}.dashboard-home .headline .btn:focus-visible{outline:3px solid var(--gold);outline-offset:3px}
      @media(max-width:600px){.dashboard-home .headline{grid-template-columns:1fr;gap:2px}.dashboard-home .continue-practice{padding:16px}.dashboard-home .stats-row{display:grid;grid-template-columns:1fr 1fr}.dashboard-home .section-head .btn{font-size:14px}}
    `}</style>
    <header className="page-header"><h2>{greeting}{profile?.name ? `, ${profile.name.split(' ')[0]}` : ''}.</h2><p className="greeting-sub">{date.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'})} · Your next steps, in one place.</p></header>
    <section className="dashboard-section" aria-labelledby="dashboard-priorities">
      <div className="section-head"><h3 id="dashboard-priorities">Your next actions</h3><span className="meta">From your saved roles &amp; outreach</span></div>
      {error && <p role="alert">{error}</p>}
      {!brief && !error && <p role="status" className="secondary-copy">Checking saved outreach…</p>}
      {!priorities.length && brief && !error && <div className="card"><p>No pending actions in your saved roles and outreach.</p><button className="btn btn-secondary" onClick={()=>setPage('discover')}>Discover jobs</button></div>}
      <div className="headline-list">{priorities.map(item=><article className="headline" key={item.id}><div><div className="meta">{item.label}</div><h4>{item.title}</h4><p>{item.reason}</p></div><button className="btn btn-primary" onClick={()=>openAction(item)}>{item.action}</button></article>)}</div>
    </section>
    <section className="dashboard-section" aria-labelledby="dashboard-today"><h3 id="dashboard-today">Practice</h3>
      <div className="continue-practice"><div><p className="section-label">{continuation?'Your saved practice':todayTasks?.date===today?'Your practice plan':todayTasks?.date?`Continue your plan from ${todayTasks.date}`:'Practice at your pace'}</p><h4>{continuation?.title||next?.text||'Choose something useful to practice'}</h4><p>{(continuation||next)?'Pick up your saved exercise, or choose a shorter session.':'Coding, system design, behavioral practice and concept review.'}</p></div>{continuation?<a className="btn btn-primary" href={continuation.href}>Continue practice</a>:<button className="btn btn-primary" onClick={()=>setPage(next?'tasks':'practice')}>{next?'Continue practice':'Choose practice'}</button>}</div>
      <div className="quick-budgets" aria-label="Practice time">{[5,15,30].map(n=><a key={n} href="#practice" onClick={e=>{e.preventDefault();sessionStorage.setItem('jq-practice-minutes',String(n));window.dispatchEvent(new CustomEvent('jq-practice-budget',{detail:n}));setPage('practice');}}><strong>{n} minutes</strong><span>{n===5?'Recall a concept':n===15?'Focus on one exercise':'Work through a session'}</span></a>)}</div>
    </section>
    <div className="today-links"><button className="card" onClick={()=>setPage('learn')}><h3>Learn on the go</h3><p>Continue a resource and save your place.</p><span>Open learning plan</span></button><button className="card" onClick={()=>setPage('resume')}><h3>Your resume</h3><p>Review your original and editable master.</p><span>Open resume</span></button></div>
    <section className="dashboard-section" aria-labelledby="dashboard-progress"><h3 id="dashboard-progress">Progress</h3><div className="stats-row"><div className="stat-card"><div className="value">{progress.streak||0}</div><div className="label">Day streak</div></div><div className="stat-card"><div className="value">{progress.completedTasks||0}/{progress.totalTasks||0}</div><div className="label">Tasks done</div></div><div className="stat-card"><div className="value">{progress.totalQuestions?`${Math.round(progress.correctAnswers/progress.totalQuestions*100)}%`:'—'}</div><div className="label">Quiz accuracy</div></div><div className="stat-card"><div className="value">{progress.daysActive||0}</div><div className="label">Days active</div></div></div><button className="btn btn-secondary" onClick={()=>setPage('calendar')}>View progress & calendar</button></section>
    <details className="card"><summary>Plan history & review status</summary><p className="secondary-copy">{pending.length} unfinished tasks in {todayTasks?.date||'your current plan'}. Imported completions remain historical progress.</p><p className="secondary-copy">Opportunity review: {brief?.generatedAt?checked(brief.generatedAt):'not available'}. Native daily run: {jobStatus?.status?.replaceAll('_',' ')||'status unavailable'}. {jobStatus?.reviewSource?.mode==='external'?' External career review is configured; its last checked sources appear in Outreach.':''} Review scheduling and connections in Setup.</p><div className="action-row"><button className="btn btn-secondary" onClick={()=>setPage('workbooks')}>Open workbooks</button><button className="btn btn-secondary" onClick={()=>setPage('setup')}>Open setup</button></div></details>
  </div>;
};
