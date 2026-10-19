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
  const pageVisible = window.useJobQuestPageVisible();
  const [profile,setProfile] = useState(null), [brief,setBrief] = useState(null), [practice,setPractice] = useState(null), [error,setError] = useState('');
  useEffect(() => {
    if (!pageVisible) return;
    let live = true;
    fetch('/api/learning').then(r=>r.ok?r.json():Promise.reject()).then(v=>{if(live)setPractice(v);}).catch(()=>{});
    fetch('/api/profile').then(r=>r.ok?r.json():Promise.reject()).then(v=>{if(live)setProfile(v);}).catch(()=>{});
    const load = () => fetch('/api/opportunities').then(r=>r.ok?r.json():Promise.reject()).then(v=>{if(live){setBrief(v);setError('');}}).catch(()=>{if(live)setError('Could not load saved outreach. Open Intel → Outreach to retry.');});
    load(); const timer = setInterval(load,30000);
    return () => {live=false;clearInterval(timer);};
  },[pageVisible]);
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
  const checked = value => value && !Number.isNaN(Date.parse(value)) ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(value)?`${value}T12:00:00`:value).toLocaleDateString(undefined,{month:'short',day:'numeric'}) : 'date unknown';
  const actionLabel = item => ({reply:'Reply',followup:'Follow up',job:'Review job',interview:'Prepare'}[item.kind]);
  const actionCompany = item => (item.kind==='job'||item.kind==='interview') ? item.role.company : item.item.company || 'Recruiter';
  const actionRole = item => (item.kind==='job'||item.kind==='interview') ? item.role.role : item.item.role || item.item.title || 'Recruiter conversation';
  const actionDate = item => item.kind==='interview' ? `Interview ${checked(new Date(item.at).toISOString())}` : item.kind==='job' ? (item.role.intelDate ? `Discovered ${checked(item.role.intelDate)}` : item.item?.checkedAt ? `Source checked ${checked(item.item.checkedAt)}` : 'Not reviewed yet') : `Verified ${checked(item.item.conversationReview?.checkedAt)}`;
  const navigate = (event,page) => { if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey) return; event.preventDefault();setPage(page); };
  const chooseMinutes = (event,minutes) => {event.preventDefault();sessionStorage.setItem('jq-practice-minutes',String(minutes));window.dispatchEvent(new CustomEvent('jq-practice-budget',{detail:minutes}));setPage('practice');};
  const arrow = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>;
  const icon = kind => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind==='reply'||kind==='followup'?<path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Zm2 5h10M7 13h6"/>:kind==='job'?<><rect x="3" y="7" width="18" height="14" rx="3"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12l9 3 9-3M12 12v4"/></>:kind==='interview'?<><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 5 3 3 5-5"/></>:kind==='listen'?<><path d="M4 14v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="12" width="4" height="8" rx="2"/><rect x="17" y="12" width="4" height="8" rx="2"/></>:<><rect x="3" y="4" width="18" height="14" rx="3"/><path d="m9 9-3 3 3 3m6-6 3 3-3 3M8 22h8m-4-4v4"/></>}</svg>;
  return <div className="dashboard-home compact-dashboard">
    <header className="page-header"><h2>{greeting}{profile?.name ? `, ${profile.name.split(' ')[0]}` : ''}.</h2><p className="greeting-sub">{date.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'})}</p></header>
    <div className="dash-workspace">
      <section className="dash-actions" aria-labelledby="dashboard-priorities">
        <div className="dash-section-head"><h3 id="dashboard-priorities">Your next actions</h3><span className="dash-count" aria-label={`${priorities.length} priority actions`}>{priorities.length}</span></div>
        <nav className="dash-shortcuts" aria-label="Explore Intel"><a href="#intel-roles" onClick={e=>navigate(e,'intel-roles')}>My roles</a><a href="#intel-outreach" onClick={e=>navigate(e,'intel-outreach')}>Outreach</a><a href="#discover" onClick={e=>navigate(e,'discover')}>Discover</a></nav>
        {error && <p role="alert" className="dash-message dash-error">{error}</p>}
        {!brief && !error && <p role="status" className="dash-message">Checking saved outreach…</p>}
        {!priorities.length && brief && !error && <div className="dash-message"><strong>You’re caught up here.</strong><p>No pending actions in your saved roles and outreach.</p><a href="#discover" onClick={e=>navigate(e,'discover')}>Explore jobs in Discover</a></div>}
        <div className="dash-action-list">{priorities.map(item=><button type="button" className={`dash-action dash-action-${item.kind}`} key={item.id} aria-label={`${item.action}: ${item.title}`} onClick={()=>openAction(item)}>
          <span className="dash-action-icon">{icon(item.kind)}</span>
          <span className="dash-action-copy"><span className="dash-action-top"><strong>{actionCompany(item)}</strong><span className="dash-action-label">{actionLabel(item)}</span></span><span className="dash-action-role">{actionRole(item)}</span><span className="dash-action-meta">{actionDate(item)}</span></span>
          <span className="dash-chevron">{arrow}</span>
        </button>)}</div>
        {priorities.length>0&&<details className="dash-reasons"><summary>Why these actions?</summary><ul>{priorities.map(item=><li key={item.id}><strong>{item.title}</strong><p>{item.reason}</p></li>)}</ul></details>}
      </section>
      <section className="dash-practice" aria-labelledby="dashboard-today">
        <div className="dash-section-head"><h3 id="dashboard-today">Practice</h3><a href="#practice" onClick={e=>navigate(e,'practice')}>All practice</a></div>
        {(continuation||next)&&<a className="dash-resume" href={continuation?.href||'#tasks'} onClick={continuation?undefined:e=>navigate(e,'tasks')}><span className="dash-resume-label">{continuation?'Continue where you left off':todayTasks?.date===today?'From today’s plan':`From your ${todayTasks?.date||'saved'} plan`}</span><strong>{continuation?.title||next.text}</strong><span className="dash-resume-link">{continuation?'Continue practice':'Open practice task'}{arrow}</span></a>}
        <div className="dash-mode-grid">
          <a className="dash-mode" href="#practice" onClick={e=>navigate(e,'practice')}><span className="dash-mode-icon">{icon('focus')}</span><strong>Focused</strong><span>Code, write or rehearse.</span><span className="dash-mode-link">Choose a session{arrow}</span></a>
          <a className="dash-mode dash-mode-listen" href="#learn" onClick={e=>navigate(e,'learn')}><span className="dash-mode-icon">{icon('listen')}</span><strong>On the go</strong><span>Listen or do a quick review.</span><span className="dash-mode-link">Open learning{arrow}</span></a>
        </div>
        <div className="dash-time"><span>Time for a focused session?</span><div aria-label="Practice time">{[5,15,30].map(n=><a key={n} href="#practice" onClick={e=>chooseMinutes(e,n)} aria-label={`${n} minutes of focused practice`}>{n} min</a>)}</div></div>
        <a className="dash-podcast" href="#dailydrop" onClick={e=>navigate(e,'dailydrop')}>{icon('listen')}<span>Daily Drop podcast</span>{arrow}</a>
      </section>
    </div>
    <nav className="dash-utilities" aria-label="Your tools"><a href="#tasks" onClick={e=>navigate(e,'tasks')}>Daily tasks</a><a href="#workbooks" onClick={e=>navigate(e,'workbooks')}>Workbooks</a><a href="#resume" onClick={e=>navigate(e,'resume')}>Resume</a><a href="#calendar" onClick={e=>navigate(e,'calendar')}>Progress &amp; calendar</a></nav>
    <details className="dash-history"><summary id="dashboard-progress">Progress &amp; review status</summary><div className="dash-progress-stats"><span><strong>{progress.streak||0}</strong> day streak</span><span><strong>{progress.completedTasks||0}/{progress.totalTasks||0}</strong> tasks done</span><span><strong>{progress.totalQuestions?`${Math.round(progress.correctAnswers/progress.totalQuestions*100)}%`:'—'}</strong> quiz accuracy</span><span><strong>{progress.daysActive||0}</strong> active days</span></div><p>{pending.length} unfinished tasks in {todayTasks?.date||'your current plan'}. Imported completions remain historical progress.</p><p>Opportunity review: {brief?.generatedAt?checked(brief.generatedAt):'not available'}. Native daily run: {jobStatus?.status?.replaceAll('_',' ')||'status unavailable'}. {jobStatus?.reviewSource?.mode==='external'?'External career review is configured; its last checked sources appear in Outreach.':''}</p><a href="#setup" onClick={e=>navigate(e,'setup')}>Review connections &amp; schedule</a></details>
  </div>;
};
