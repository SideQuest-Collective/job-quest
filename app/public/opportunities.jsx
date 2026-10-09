/* Loaded as a Babel script by the Job Quest shell. */
window.dedupeJobQuestRoles = function dedupeJobQuestRoles(reports) {
  const normalized = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const canonical = value => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') return null;
      url.hash = '';
      url.pathname = url.pathname.replace(/\/+$/, '') || '/';
      for (const key of [...url.searchParams.keys()]) {
        if (/^(utm_|gh_src$|source$|ref$|trk$|tracking)/i.test(key)) url.searchParams.delete(key);
      }
      url.searchParams.sort();
      return url.href;
    } catch { return null; }
  };
  const seen = new Set(), roles = [];
  for (const report of reports || []) {
    for (const role of report.roles || []) {
      const title = normalized(role.role);
      const company = normalized(role.company);
      const url = canonical(role.url);
      const key = `${company}|${title}|${url || normalized(role.location)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      roles.push({ ...role, intelDate: report.date });
    }
  }
  return roles;
};

window.mergeJobQuestDrafts = function mergeJobQuestDrafts(previous, previousServer, freshItems) {
  const next = { ...previous };
  for (const item of freshItems) {
    const local = previous[item.id];
    const dirty = local !== undefined && previousServer[item.id] !== undefined && local !== previousServer[item.id];
    next[item.id] = dirty ? local : (item.draftReply || '');
  }
  return next;
};

window.filterJobQuestCards = function filterJobQuestCards(items, view, catchUp, now = Date.now()) {
  const deferred = item => item.status?.startsWith('hold') || ['snoozed', 'declined', 'reconnect_scheduled'].includes(item.status);
  return items.filter(item => view === 'jobs' ? item.kind === 'job'
    : item.kind === 'recruiter' && (view === 'held' ? deferred(item) : !deferred(item)))
    .filter(item => !catchUp || view !== 'outreach' || (
      !['awaiting_recruiter', 'meeting_booked'].includes(item.status)
      && (!item.nextReminderAt || Date.parse(item.nextReminderAt) <= now)))
    .sort((a, b) => catchUp && view === 'outreach'
      ? (a.lastInboundAt || a.checkedAt || '').localeCompare(b.lastInboundAt || b.checkedAt || '')
      : (b.checkedAt || '').localeCompare(a.checkedAt || ''));
};

window.Opportunities = function Opportunities({ setPage }) {
  const { useEffect, useState } = React;
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);
  const [view, setView] = useState('outreach');
  const [catchUp, setCatchUp] = useState(false);
  const [drafts, setDrafts] = useState({});
  const [until, setUntil] = useState({});
  const [accountKind, setAccountKind] = useState('gmail');
  const [accountLabel, setAccountLabel] = useState('');
  const serverDrafts = React.useRef({});

  const load = async ({ clearError = true } = {}) => {
    try {
      const response = await fetch('/api/opportunities');
      if (!response.ok) throw Error('Could not load opportunities.');
      const fresh = await response.json();
      setData(fresh);
      const previousServer = serverDrafts.current;
      setDrafts(previous => window.mergeJobQuestDrafts(previous, previousServer, fresh.opportunities));
      serverDrafts.current = Object.fromEntries(fresh.opportunities.map(item => [item.id, item.draftReply || '']));
      if (clearError) setError('');
    } catch (cause) { setError(cause.message); }
  };

  useEffect(() => { load(); }, []);

  const mutate = async (item, action, extra = {}) => {
    if (!item.revision) return;
    if (action !== 'draft' && drafts[item.id] !== item.draftReply) {
      setError('Save the edited draft before changing this reminder.');
      return;
    }
    setBusy(item.id);
    setError('');
    try {
      const response = await fetch(`/api/opportunities/${encodeURIComponent(item.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: item.revision, action, ...extra }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || 'Could not save this change.');
      await load();
    } catch (cause) { setError(cause.message); if (cause.message.includes('Refresh')) await load({ clearError: false }); }
    finally { setBusy(null); }
  };

  const saveAccounts = async accounts => {
    setBusy('accounts'); setError('');
    try {
      const response = await fetch('/api/opportunities/accounts', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: data.accountsRevision, accounts }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || 'Could not save sources.');
      setAccountLabel('');
      await load();
    } catch (cause) { setError(cause.message); if (cause.message.includes('Refresh')) await load({ clearError: false }); }
    finally { setBusy(null); }
  };

  const addAccount = event => {
    event.preventDefault();
    const label = accountLabel.trim();
    if (!label || !data) return;
    if (data.accounts.some(account => account.kind === accountKind && account.label.trim().toLowerCase() === label.toLowerCase())) {
      setError('This account is already selected.');
      return;
    }
    const id = `source_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    saveAccounts([...data.accounts, { id, kind: accountKind, label }]);
  };

  const copyDraft = async item => {
    try { await navigator.clipboard.writeText(drafts[item.id] || ''); }
    catch { setError('Could not copy the draft. Select the text and copy it manually.'); }
  };

  const items = data?.opportunities || [];
  const visible = window.filterJobQuestCards(items, view, catchUp);

  return <div className="jq-opps">
    <style>{`
      .jq-opps { max-width: 1060px; margin: 0 auto; color: var(--text); }
      .jq-opps h2 { font-size: 24px; margin: 0 0 5px; }
      .jq-opps p { line-height: 1.5; }
      .jq-opps .intro { color: var(--text-secondary); margin: 0 0 18px; }
      .jq-opps .tabs,.jq-opps .actions,.jq-opps .links { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
      .jq-opps button,.jq-opps select,.jq-opps input,.jq-opps textarea { font:inherit; }
      .jq-opps button { border:1px solid var(--border); border-radius:8px; background:var(--bg-surface); color:var(--text); padding:9px 12px; cursor:pointer; }
      .jq-opps button.active { border-color:var(--amber); color:var(--amber); }
      .jq-opps button:focus-visible,.jq-opps a:focus-visible,.jq-opps summary:focus-visible,.jq-opps input:focus-visible,.jq-opps select:focus-visible,.jq-opps textarea:focus-visible { outline:2px solid var(--amber); outline-offset:2px; }
      .jq-opps button:disabled { opacity:.5; cursor:default; }
      .jq-opps a { color:var(--amber); overflow-wrap:anywhere; }
      .jq-opps .panel { background:var(--bg-surface); border:1px solid var(--border); border-radius:12px; padding:16px; margin-top:14px; }
      .jq-opps .op-card { padding:14px 16px; }
      .jq-opps .card-head { display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; align-items:start; }
      .jq-opps .card-head h3 { font-size:17px; margin:0; line-height:1.3; }
      .jq-opps .muted,.jq-opps small { color:var(--text-muted); }
      .jq-opps .status { font-size:12px; color:var(--amber); overflow-wrap:anywhere; }
      .jq-opps .next-action { margin:10px 0; font-size:13px; color:var(--text-secondary); display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
      .jq-opps .primary-links { margin:10px 0; }
      .jq-opps .primary-links a { display:inline-flex; align-items:center; min-height:40px; }
      .jq-opps .op-details { margin-top:10px; border-top:1px solid var(--border); padding-top:9px; }
      .jq-opps summary { cursor:pointer; }
      .jq-opps .op-details summary { color:var(--amber); font-size:13px; font-weight:600; min-height:40px; display:flex; align-items:center; }
      .jq-opps .secondary-panel { padding:10px 14px; font-size:13px; }
      .jq-opps .secondary-panel > summary { color:var(--text-secondary); min-height:40px; display:flex; align-items:center; }
      .jq-opps .detail-body { padding-top:10px; }
      .jq-opps textarea { box-sizing:border-box; width:100%; min-height:76px; padding:10px; border-radius:8px; border:1px solid var(--border); background:var(--bg); color:var(--text); }
      .jq-opps input,.jq-opps select { min-height:40px; padding:7px; border-radius:8px; border:1px solid var(--border); background:var(--bg); color:var(--text); max-width:100%; box-sizing:border-box; }
      .jq-opps .account-form { display:flex; gap:8px; flex-wrap:wrap; align-items:end; }
      .jq-opps .account-form label { display:flex; flex-direction:column; gap:5px; }
      .jq-opps .error { border-color:var(--rose); color:var(--rose); }
      @media(max-width:390px) { .jq-opps { padding:0 2px; } .jq-opps .panel { padding:13px; } .jq-opps .op-card { padding:12px 13px; } .jq-opps .actions button { flex:1 1 auto; } }
    `}</style>
    <h2>Opportunities</h2>
    <p className="intro">Review sourced roles and outreach. You choose when to reply, book, or apply.</p>
    <div className="tabs" role="group" aria-label="Opportunity views">
      <button className={view === 'outreach' ? 'active' : ''} onClick={() => setView('outreach')}>Outreach</button>
      <button className={view === 'jobs' ? 'active' : ''} onClick={() => setView('jobs')}>Jobs</button>
      <button className={view === 'held' ? 'active' : ''} onClick={() => setView('held')}>Paused</button>
    </div>
    {error && <div role="alert" className="panel error">{error}</div>}
    {!data ? <div className="panel">Loading local opportunities…</div> : <>
      {catchUp && view === 'outreach' && <p className="muted">Older conversations need a fresh source check before a reply is considered due. Paused, snoozed and scheduled reconnects stay in their own view.</p>}
      {data.briefState !== 'ready' && <div className="panel" role="status">Career review brief: {data.briefState.replace('_', ' ')}. Queue history may still appear; its source status needs rechecking.</div>}
      {data.queueState !== 'ready' && <div className="panel" role="status">Recruiter queue: {data.queueState.replace('_', ' ')}. Draft and reminder changes are unavailable.</div>}
      <details className="panel secondary-panel"><summary>Sources, accounts & more{data.sources.some(source => source.status === 'blocked') ? ` · ${data.sources.filter(source => source.status === 'blocked').length} blocked` : ''}</summary><div className="detail-body">
        <div className="actions">
          <button onClick={() => load()}>Refresh local results</button>
          <button className={catchUp ? 'active' : ''} onClick={() => { setView('outreach'); setCatchUp(!catchUp); }}>{catchUp ? 'Show recent order' : 'Review older outreach'}</button>
          {setPage && <button onClick={() => setPage('discover')}>Native Discover</button>}
        </div>
        {data.generatedAt && <p className="muted">Brief generated {new Date(data.generatedAt).toLocaleString()}.</p>}
        {data.sources.length > 0 && <><h3>Source coverage</h3>
          {data.sources.map((source, index) => <p key={`${source.name}-${index}`}><strong>{source.name}</strong> · {source.status} · {source.checkedAt ? new Date(source.checkedAt).toLocaleString() : 'time unknown'}<br /><span className="muted">{source.detail}</span></p>)}
          {data.coverage.backfill?.detail && <p>Pending backfill: {data.coverage.backfill.detail}</p>}
          {data.coverage.invitations?.detail && <p>Invitations: {data.coverage.invitations.detail}</p>}
        </>}
        <h3>Accounts to review</h3>
        <p className="muted">Selecting an account records your preference. Access and scanning must be verified separately. LinkedIn email notifications cover only messages that generated email; they do not cover the full LinkedIn inbox or invitations.</p>
        {data.accounts.map(account => {
          const source = data.sources.find(s => s.accountId === account.id || (account.sourceName && s.name === account.sourceName));
          return <div key={account.id} className="actions" style={{ marginBottom: 8 }}>
            <span>{account.label} · {account.kind.replaceAll('_', ' ')} · <span className="status">Access {account.accessStatus || 'unverified'}{account.accessCheckedAt ? ` ${new Date(account.accessCheckedAt).toLocaleDateString()}` : ''}; {source ? `review ${source.status} ${source.checkedAt || ''}` : 'review coverage unverified'}</span></span>
            <label>Coverage source <select value={account.sourceName || ''} disabled={busy === 'accounts'} onChange={event => saveAccounts(data.accounts.map(a => a.id === account.id ? { ...a, sourceName: event.target.value } : a))}>
              <option value="">Not mapped</option>
              {data.sources.map((s, index) => <option value={s.name} key={`${s.name}-${index}`}>{s.name}</option>)}
            </select></label>
            <button disabled={busy === 'accounts'} onClick={() => saveAccounts(data.accounts.filter(a => a.id !== account.id))}>Remove</button>
          </div>;
        })}
        <form className="account-form" onSubmit={addAccount}>
          <label>Source<select value={accountKind} onChange={event => setAccountKind(event.target.value)}><option value="gmail">Gmail</option><option value="linkedin_email">LinkedIn email notifications</option><option value="linkedin">LinkedIn direct inbox</option></select></label>
          <label>Account or profile label<input value={accountLabel} onChange={event => setAccountLabel(event.target.value)} placeholder="Account to review" maxLength="150" /></label>
          <button type="submit" disabled={busy === 'accounts' || !accountLabel.trim()}>Add account</button>
        </form>
      </div></details>
      {visible.length === 0 && <div className="panel" role="status">{data.briefState === 'ready' ? 'No results in this view from the latest local brief.' : 'Results unavailable until the local brief is connected.'}</div>}
      {visible.map(item => <article className="panel op-card" key={item.id}>
        <div className="card-head"><div><h3>{item.title} · {item.company}</h3><small>{item.location}{item.checkedAt ? ` · checked ${new Date(item.checkedAt).toLocaleDateString()}` : ' · source needs review'}</small></div>
          {(item.kind === 'job' ? item.availability : item.status && !['ready_for_review'].includes(item.status)) && <span className="status">{item.kind === 'job' ? item.availability : item.status.replaceAll('_', ' ')}</span>}
        </div>
        {item.nextAction && <p className="next-action"><strong>From last check:</strong> {item.nextAction}</p>}
        <div className="links primary-links">
          {item.sourceLinks[0] && <a href={item.sourceLinks[0]} target="_blank" rel="noopener noreferrer">{item.kind === 'job' ? 'Open listing' : 'Open conversation'}</a>}
          {item.schedulingUrl && <a href={item.schedulingUrl} target="_blank" rel="noopener noreferrer">Recruiter calendar</a>}
        </div>
        <details className="op-details"><summary>{item.kind === 'recruiter' ? 'Review reply & details' : 'More role details'}</summary>
          {item.queueOnly && <p className="muted">Queue history · review the original conversation for current status.</p>}
          {item.summary && <p>{item.summary}</p>}
          {item.fit && <p><strong>Fit:</strong> {item.fit}</p>}
          {item.concern && <p><strong>Consider:</strong> {item.concern}</p>}
          {item.nextAction && <p><strong>Full next action from last check:</strong> {item.nextAction}</p>}
          {item.nextReminderAt && <p className="muted">Reminder review: {new Date(item.nextReminderAt).toLocaleString()}</p>}
          {item.sourceLinks.length > 1 && <div className="links">{item.sourceLinks.slice(1).map(url => <a key={url} href={url} target="_blank" rel="noopener noreferrer">Related source · {new URL(url).hostname.replace(/^www\./, '')}</a>)}</div>}
        {item.kind === 'recruiter' && <>
          <label style={{ display:'block', marginTop: 12 }}>Suggested reply
            <textarea value={drafts[item.id] ?? item.draftReply} onChange={event => setDrafts({ ...drafts, [item.id]: event.target.value })} readOnly={!item.editable} aria-label={`Draft reply for ${item.company}`} />
          </label>
          <div className="actions">
            <button disabled={!item.editable || busy === item.id || drafts[item.id] === item.draftReply} onClick={() => mutate(item, 'draft', { draftReply: drafts[item.id] })}>Save draft</button>
            <button onClick={() => copyDraft(item)}>Copy reply</button>
            <button disabled={!item.editable || busy === item.id} onClick={() => mutate(item, item.status?.startsWith('hold') ? 'reopen' : 'hold')}>{item.status?.startsWith('hold') ? 'Resume reminders' : 'Pause reminders'}</button>
            <button disabled={!item.editable || busy === item.id || Boolean(item.sentAt)} onClick={() => mutate(item, 'sent')}>I sent this</button>
          </div>
          <div className="actions" style={{ marginTop:8 }}>
            <label>Snooze until <input type="datetime-local" value={until[item.id] || ''} onChange={event => setUntil({ ...until, [item.id]: event.target.value })} /></label>
            <button disabled={!item.editable || busy === item.id || !until[item.id]} onClick={() => mutate(item, 'snooze', { until: new Date(until[item.id]).toISOString() })}>Snooze</button>
            <button disabled={!item.editable || busy === item.id} onClick={() => mutate(item, 'skip')}>Skip</button>
          </div>
        </>}
        </details>
      </article>)}
    </>}
  </div>;
};
