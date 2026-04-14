# Intel Mission Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the read-only Intel page into a two-panel CRM-style mission control where each role is a trackable entity with pipeline stages, prep checklists, notes, tips, and timeline.

**Architecture:** Two-panel layout (left: filterable role list, right: role detail/mission control). New `role-tracker.json` data file stores per-role state. Syncs with existing `role-actions.json` from Discover. All changes auto-save and log to activity journal.

**Tech Stack:** React 18 (CDN), Express.js, JSON file storage. No new dependencies.

---

### Task 1: Backend - Role Tracker API Endpoints

**Files:**
- Modify: `server.js` (add endpoints after existing role-actions routes, around line 215)
- Create: `data/role-tracker.json` (seed file)

- [ ] **Step 1: Create seed data file**

Create `data/role-tracker.json`:
```json
{}
```

- [ ] **Step 2: Add GET /api/role-tracker endpoint**

In `server.js`, after the `POST /api/role-actions` handler (around line 215), add:

```javascript
// Role tracker (Intel mission control)
app.get('/api/role-tracker', (req, res) => {
  const file = path.join(DATA_DIR, 'role-tracker.json');
  if (fs.existsSync(file)) {
    res.json(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } else {
    res.json({});
  }
});
```

- [ ] **Step 3: Add POST /api/role-tracker endpoint**

Immediately after the GET endpoint, add:

```javascript
app.post('/api/role-tracker', (req, res) => {
  const file = path.join(DATA_DIR, 'role-tracker.json');
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
  fs.writeFileSync(file, JSON.stringify(req.body, null, 2));
  // Log stage changes to activity journal
  Object.keys(req.body).forEach(key => {
    if (!prev[key]) {
      logActivity('role_tracked', { role: key, stage: req.body[key].stage });
    } else if (prev[key].stage !== req.body[key].stage) {
      logActivity('role_stage_change', { role: key, from: prev[key].stage, to: req.body[key].stage });
    }
  });
  res.json({ success: true });
});
```

- [ ] **Step 4: Test endpoints**

```bash
# Test GET (empty)
curl -s http://localhost:3847/api/role-tracker
# Expected: {}

# Test POST
curl -s -X POST http://localhost:3847/api/role-tracker \
  -H 'Content-Type: application/json' \
  -d '{"Google|Staff SDE":{"stage":"discovered","notes":"","checklist":[],"timeline":[]}}'
# Expected: {"success":true}

# Test GET (with data)
curl -s http://localhost:3847/api/role-tracker
# Expected: {"Google|Staff SDE":{...}}
```

- [ ] **Step 5: Restart server and verify**

```bash
# Kill and restart
lsof -ti :3847 | xargs kill; sleep 1 && node server.js &
```

---

### Task 2: CSS - Intel Mission Control Styles

**Files:**
- Modify: `public/index.html` (CSS section, insert before the `/* ===== CODE LAB ===== */` comment)

- [ ] **Step 1: Add Intel mission control CSS**

Insert the following CSS block before the `/* ===== CODE LAB ===== */` comment in the `<style>` tag:

```css
  /* ===== INTEL MISSION CONTROL ===== */
  .intel-split { display: grid; grid-template-columns: 300px 1fr; flex: 1; min-height: 0; gap: 0; }
  .intel-left { overflow-y: auto; border-right: 1px solid var(--border); background: rgba(10,15,30,0.5); padding: 0; display: flex; flex-direction: column; }
  .intel-left-header { padding: 16px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
  .intel-filter-tabs { display: flex; gap: 2px; background: rgba(15,23,42,0.5); border-radius: 8px; padding: 3px; }
  .intel-filter-tab { flex: 1; text-align: center; padding: 6px 8px; border-radius: 6px; font-size: 11px; cursor: pointer; color: var(--text-muted); font-weight: 600; font-family: var(--font-mono); transition: all 0.15s; white-space: nowrap; }
  .intel-filter-tab:hover { color: var(--text-secondary); }
  .intel-filter-tab.active { background: var(--amber-dim); color: var(--amber); }
  .intel-role-list { flex: 1; overflow-y: auto; padding: 8px; }
  .intel-role-item { padding: 12px 14px; border-radius: 10px; cursor: pointer; margin-bottom: 4px; transition: all 0.15s; border: 1px solid transparent; position: relative; }
  .intel-role-item:hover { background: var(--bg-surface); }
  .intel-role-item.active { background: var(--amber-dim); border-color: rgba(251,191,36,0.2); }
  .intel-role-item .iri-company { font-size: 11px; font-family: var(--font-mono); font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 3px; display: flex; align-items: center; gap: 6px; }
  .intel-role-item .iri-title { font-size: 13px; font-weight: 600; color: var(--text); line-height: 1.3; }
  .intel-role-item .iri-meta { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); }
  .intel-role-item .iri-new { font-size: 9px; padding: 1px 6px; border-radius: 4px; background: var(--amber-dim); color: var(--amber); font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
  .stage-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .stage-discovered { background: var(--text-muted); }
  .stage-researching { background: var(--violet); }
  .stage-applied { background: var(--amber); }
  .stage-phone-screen { background: var(--cyan); }
  .stage-onsite { background: var(--blue); }
  .stage-offer { background: var(--emerald); box-shadow: 0 0 6px rgba(52,211,153,0.4); }
  .stage-rejected { background: var(--rose); }

  .intel-right { overflow-y: auto; padding: 28px; }
  .intel-right-empty { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-muted); font-size: 14px; }

  /* Stage stepper */
  .stage-stepper { display: flex; align-items: center; gap: 0; margin: 16px 0 24px; }
  .stage-step { display: flex; align-items: center; gap: 0; }
  .stage-step-dot { width: 28px; height: 28px; border-radius: 50%; border: 2px solid var(--border); display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.2s; font-size: 10px; font-family: var(--font-mono); font-weight: 700; color: var(--text-muted); position: relative; }
  .stage-step-dot:hover { border-color: var(--text-secondary); }
  .stage-step-dot.current { border-color: var(--amber); background: var(--amber-dim); color: var(--amber); }
  .stage-step-dot.completed { border-color: var(--emerald); background: var(--emerald-dim); color: var(--emerald); }
  .stage-step-dot.rejected { border-color: var(--rose); background: var(--rose-dim); color: var(--rose); }
  .stage-step-label { font-size: 9px; color: var(--text-muted); font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.5px; position: absolute; top: 32px; white-space: nowrap; left: 50%; transform: translateX(-50%); }
  .stage-step-line { width: 24px; height: 2px; background: var(--border); }
  .stage-step-line.completed { background: var(--emerald); }

  /* Mission control sections */
  .mc-section { margin-bottom: 24px; }
  .mc-section-title { font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1.5px; font-family: var(--font-mono); font-weight: 600; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
  .mc-section-title svg { width: 14px; height: 14px; }
  .mc-fit { font-size: 14px; line-height: 1.7; color: var(--text-secondary); padding: 14px 16px; background: var(--bg-surface); border-radius: 10px; border: 1px solid var(--border); border-left: 3px solid var(--emerald); }

  /* Checklist */
  .mc-checklist-item { display: flex; align-items: flex-start; gap: 10px; padding: 8px 0; font-size: 13px; }
  .mc-checklist-item .checkbox { width: 18px; height: 18px; border-radius: 5px; margin-top: 1px; }
  .mc-checklist-item.done { opacity: 0.5; }
  .mc-checklist-item.done span { text-decoration: line-through; }
  .mc-add-item { display: flex; gap: 8px; margin-top: 8px; }
  .mc-add-item input { flex: 1; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 12px; color: var(--text); font-family: var(--font-display); font-size: 13px; outline: none; }
  .mc-add-item input:focus { border-color: var(--amber); }

  /* Notes */
  .mc-notes { width: 100%; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; color: var(--text); font-family: var(--font-display); font-size: 14px; resize: vertical; min-height: 80px; outline: none; line-height: 1.6; }
  .mc-notes:focus { border-color: var(--amber); }

  /* Timeline */
  .mc-timeline-item { display: flex; gap: 12px; padding: 8px 0; font-size: 12px; position: relative; }
  .mc-timeline-item::before { content: ''; position: absolute; left: 5px; top: 24px; bottom: -8px; width: 1px; background: var(--border); }
  .mc-timeline-item:last-child::before { display: none; }
  .mc-timeline-dot { width: 11px; height: 11px; border-radius: 50%; background: var(--border); flex-shrink: 0; margin-top: 2px; }
  .mc-timeline-date { color: var(--text-muted); font-family: var(--font-mono); width: 80px; flex-shrink: 0; }
  .mc-timeline-event { color: var(--text-secondary); }
  .mc-add-timeline { display: flex; gap: 8px; margin-top: 8px; padding-left: 23px; }

  .mc-actions { display: flex; gap: 10px; margin-top: 20px; padding-top: 20px; border-top: 1px solid var(--border); }

  @media (max-width: 900px) {
    .intel-split { grid-template-columns: 1fr; }
    .intel-left { max-height: 250px; border-right: none; border-bottom: 1px solid var(--border); }
    .stage-stepper { flex-wrap: wrap; gap: 4px; }
    .stage-step-label { display: none; }
  }
```

---

### Task 3: Frontend - Intel Component (Left Panel)

**Files:**
- Modify: `public/index.html` (replace the existing `function Intel` component around line 940)

- [ ] **Step 1: Update nav item label**

Find `{ id: 'intel', icon: Icons.radar, label: 'Intel Reports' }` and change to:
```javascript
{ id: 'intel', icon: Icons.radar, label: 'Intel' },
```

- [ ] **Step 2: Update main class for intel page**

Change:
```javascript
<div className={`main ${page === 'codelab' ? 'main-fullheight' : ''}`}>
```
To:
```javascript
<div className={`main ${page === 'codelab' || page === 'intel' ? 'main-fullheight' : ''}`}>
```

- [ ] **Step 3: Update Intel component props in page routing**

Change:
```javascript
{page === 'intel' && <Intel allIntel={allIntel} />}
```
To:
```javascript
{page === 'intel' && <Intel allIntel={allIntel} allRoles={allRoles} roleActions={roleActions} setPage={setPage} />}
```

- [ ] **Step 4: Add role-tracker state to App component**

In the `App` function, after the existing `roleActions` state declaration, add:
```javascript
const [roleTracker, setRoleTracker] = useState({});
```

In the `refresh` callback, add:
```javascript
api.get('/api/role-tracker').then(setRoleTracker);
```

Update the Intel route to pass tracker:
```javascript
{page === 'intel' && <Intel allIntel={allIntel} allRoles={allRoles} roleActions={roleActions} roleTracker={roleTracker} setRoleTracker={setRoleTracker} setPage={setPage} />}
```

- [ ] **Step 5: Replace the Intel component**

Replace the entire `function Intel({ allIntel })` through its closing `}` with the new Intel component. This is a large replacement — the full code is in the next step.

```javascript
const STAGES = ['discovered','researching','applied','phone-screen','onsite','offer','rejected'];
const STAGE_LABELS = { discovered:'Discovered', researching:'Researching', applied:'Applied', 'phone-screen':'Phone Screen', onsite:'Onsite', offer:'Offer', rejected:'Rejected' };
const STAGE_COLORS = { discovered:'var(--text-muted)', researching:'var(--violet)', applied:'var(--amber)', 'phone-screen':'var(--cyan)', onsite:'var(--blue)', offer:'var(--emerald)', rejected:'var(--rose)' };
const DEFAULT_CHECKLISTS = {
  discovered: ['Research team & recent launches', 'Read job description thoroughly'],
  researching: ['Identify team members on LinkedIn', 'Read recent company blog posts', 'Note key product areas'],
  applied: ['Prepare 2 STAR stories relevant to this role', 'Review company values & mission'],
  'phone-screen': ['Practice 60-second pitch', 'Prepare questions for recruiter', 'Research interviewer on LinkedIn'],
  onsite: ['Practice system design problems in Code Lab', 'Do a mock interview', 'Review company tech stack', 'Prepare behavioral stories'],
  offer: ['Review compensation details', 'Prepare negotiation points'],
  rejected: [],
};

function Intel({ allIntel, allRoles, roleActions, roleTracker, setRoleTracker, setPage }) {
  const [selectedKey, setSelectedKey] = useState(null);
  const [filter, setFilter] = useState('all');
  const [newCheckItem, setNewCheckItem] = useState('');
  const [newTimelineEvent, setNewTimelineEvent] = useState('');
  const saveTimer = useRef(null);

  // Build role list: all roles from all intel, merged with tracker data
  const allTips = allIntel.flatMap(r => r.tips || []);
  const roleMap = {};
  allRoles.forEach(r => {
    const key = `${r.company}|${r.role}`;
    if (!roleMap[key]) roleMap[key] = { ...r, key };
  });

  // Determine stage for each role
  const getRoleStage = (key) => {
    if (roleTracker[key]) return roleTracker[key].stage;
    if (roleActions.applied?.includes(key)) return 'applied';
    if (roleActions.saved?.includes(key)) return 'discovered';
    return 'discovered';
  };

  const roles = Object.values(roleMap).map(r => ({
    ...r,
    stage: getRoleStage(r.key),
    tracked: !!roleTracker[r.key],
    lastActivity: roleTracker[r.key]?.timeline?.slice(-1)[0]?.date || r.intelDate || '',
  }));

  // Filter
  const filtered = roles.filter(r => {
    if (filter === 'all') return r.stage !== 'rejected';
    if (filter === 'active') return ['discovered','researching'].includes(r.stage);
    if (filter === 'applied') return r.stage === 'applied';
    if (filter === 'interviewing') return ['phone-screen','onsite'].includes(r.stage);
    if (filter === 'archived') return ['offer','rejected'].includes(r.stage);
    return true;
  }).sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));

  // Auto-select first role
  useEffect(() => {
    if (!selectedKey && filtered.length > 0) setSelectedKey(filtered[0].key);
  }, [filtered.length]);

  const selected = selectedKey ? roleMap[selectedKey] : null;
  const tracker = selectedKey ? (roleTracker[selectedKey] || null) : null;
  const stage = selectedKey ? getRoleStage(selectedKey) : 'discovered';
  const companyTips = selected ? allTips.filter(t => t.company && selected.company.toLowerCase().includes(t.company.toLowerCase())) : [];

  // Save tracker with debounce
  const saveTracker = (updated) => {
    setRoleTracker(updated);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { api.post('/api/role-tracker', updated); }, 500);
  };

  // Ensure tracker entry exists
  const ensureTracker = () => {
    if (!selectedKey) return roleTracker;
    if (roleTracker[selectedKey]) return roleTracker;
    const now = new Date().toISOString();
    const entry = {
      stage: getRoleStage(selectedKey),
      notes: '',
      checklist: DEFAULT_CHECKLISTS[getRoleStage(selectedKey)]?.map(t => ({ text: t, done: false })) || [],
      timeline: [{ date: now, event: 'Added to tracker' }],
    };
    const updated = { ...roleTracker, [selectedKey]: entry };
    saveTracker(updated);
    return updated;
  };

  const setStage = (newStage) => {
    const t = ensureTracker();
    const now = new Date().toISOString();
    const entry = { ...t[selectedKey], stage: newStage };
    entry.timeline = [...(entry.timeline || []), { date: now, event: `Stage changed to ${STAGE_LABELS[newStage]}` }];
    // Add default checklist items for new stage if checklist is empty or all done
    const defaults = DEFAULT_CHECKLISTS[newStage] || [];
    if (defaults.length > 0) {
      const existing = new Set((entry.checklist || []).map(c => c.text));
      defaults.forEach(d => { if (!existing.has(d)) entry.checklist = [...(entry.checklist || []), { text: d, done: false }]; });
    }
    saveTracker({ ...t, [selectedKey]: entry });
  };

  const toggleCheckItem = (idx) => {
    const t = ensureTracker();
    const entry = { ...t[selectedKey] };
    entry.checklist = [...entry.checklist];
    entry.checklist[idx] = { ...entry.checklist[idx], done: !entry.checklist[idx].done };
    saveTracker({ ...t, [selectedKey]: entry });
  };

  const addCheckItem = () => {
    if (!newCheckItem.trim()) return;
    const t = ensureTracker();
    const entry = { ...t[selectedKey] };
    entry.checklist = [...(entry.checklist || []), { text: newCheckItem.trim(), done: false }];
    saveTracker({ ...t, [selectedKey]: entry });
    setNewCheckItem('');
  };

  const removeCheckItem = (idx) => {
    const t = ensureTracker();
    const entry = { ...t[selectedKey] };
    entry.checklist = entry.checklist.filter((_, i) => i !== idx);
    saveTracker({ ...t, [selectedKey]: entry });
  };

  const updateNotes = (val) => {
    const t = ensureTracker();
    saveTracker({ ...t, [selectedKey]: { ...t[selectedKey], notes: val } });
  };

  const addTimelineEvent = () => {
    if (!newTimelineEvent.trim()) return;
    const t = ensureTracker();
    const entry = { ...t[selectedKey] };
    entry.timeline = [...(entry.timeline || []), { date: new Date().toISOString(), event: newTimelineEvent.trim() }];
    saveTracker({ ...t, [selectedKey]: entry });
    setNewTimelineEvent('');
  };

  const timeAgo = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const now = new Date();
    const diff = Math.floor((now - d) / 86400000);
    if (diff === 0) return 'today';
    if (diff === 1) return '1d ago';
    return `${diff}d ago`;
  };

  return (
    <>
      <div className="codelab-toolbar anim-enter">
        <h2>Intel</h2>
        <div style={{flex:1}} />
        <span style={{fontSize:12,color:'var(--text-muted)',fontFamily:'var(--font-mono)'}}>{roles.length} roles tracked</span>
      </div>

      <div className="intel-split anim-enter anim-delay-1" style={{border:'1px solid var(--border)',borderRadius:'var(--radius)',overflow:'hidden'}}>
        {/* Left Panel */}
        <div className="intel-left">
          <div className="intel-left-header">
            <div className="intel-filter-tabs">
              {[['all','All'],['active','Active'],['applied','Applied'],['interviewing','Interview'],['archived','Archive']].map(([id,label]) => (
                <div key={id} className={`intel-filter-tab ${filter===id?'active':''}`} onClick={() => setFilter(id)}>{label}</div>
              ))}
            </div>
          </div>
          <div className="intel-role-list">
            {filtered.map(r => (
              <div key={r.key} className={`intel-role-item ${selectedKey===r.key?'active':''}`} onClick={() => setSelectedKey(r.key)}>
                <div className="iri-company">
                  <span className={`stage-dot stage-${r.stage}`} />
                  {r.company}
                  {!r.tracked && !roleActions.saved?.includes(r.key) && !roleActions.applied?.includes(r.key) && <span className="iri-new">new</span>}
                </div>
                <div className="iri-title">{r.role}</div>
                <div className="iri-meta">
                  <span>{r.level}</span>
                  <span>&middot;</span>
                  <span>{STAGE_LABELS[r.stage]}</span>
                  {r.lastActivity && <><span>&middot;</span><span>{timeAgo(r.lastActivity)}</span></>}
                </div>
              </div>
            ))}
            {filtered.length === 0 && <div style={{padding:24,textAlign:'center',color:'var(--text-muted)',fontSize:13}}>No roles in this filter.</div>}
          </div>
        </div>

        {/* Right Panel */}
        <div className="intel-right">
          {selected ? (
            <>
              {/* Header */}
              <div style={{marginBottom:8}}>
                <div style={{fontSize:12,fontFamily:'var(--font-mono)',color:STAGE_COLORS[stage],fontWeight:600,textTransform:'uppercase',letterSpacing:1.5,marginBottom:4}}>{selected.company}</div>
                <h3 style={{fontSize:22,fontWeight:700,marginBottom:4}}>{selected.role}</h3>
                <div style={{fontSize:13,color:'var(--text-muted)',fontFamily:'var(--font-mono)'}}>{selected.level} &middot; {selected.location}</div>
              </div>

              {/* Stage Stepper */}
              <div className="stage-stepper" style={{marginBottom:28}}>
                {STAGES.filter(s => s !== 'rejected').map((s, i, arr) => {
                  const stageIdx = STAGES.indexOf(stage);
                  const thisIdx = STAGES.indexOf(s);
                  const isCurrent = s === stage;
                  const isCompleted = stage !== 'rejected' && thisIdx < stageIdx;
                  return (
                    <div key={s} className="stage-step">
                      <div className={`stage-step-dot ${isCurrent ? 'current' : ''} ${isCompleted ? 'completed' : ''}`}
                        style={isCurrent ? {borderColor: STAGE_COLORS[s], background: `${STAGE_COLORS[s]}22`, color: STAGE_COLORS[s]} : {}}
                        onClick={() => setStage(s)}>
                        {isCompleted ? <Icons.check style={{width:12,height:12}} /> : (i + 1)}
                        <span className="stage-step-label">{STAGE_LABELS[s]}</span>
                      </div>
                      {i < arr.length - 1 && <div className={`stage-step-line ${isCompleted ? 'completed' : ''}`} />}
                    </div>
                  );
                })}
                <div style={{marginLeft:12}}>
                  <div className={`stage-step-dot ${stage === 'rejected' ? 'rejected' : ''}`} onClick={() => setStage(stage === 'rejected' ? 'discovered' : 'rejected')} style={{width:24,height:24,fontSize:9}}>
                    <Icons.x style={{width:10,height:10}} />
                  </div>
                </div>
              </div>

              {/* Fit Analysis */}
              {selected.fit && (
                <div className="mc-section">
                  <div className="mc-section-title"><Icons.zap style={{width:14,height:14,color:'var(--emerald)'}} /> Why This Fits You</div>
                  <div className="mc-fit">{selected.fit}</div>
                </div>
              )}

              {/* Prep Checklist */}
              <div className="mc-section">
                <div className="mc-section-title"><Icons.checkSquare style={{width:14,height:14,color:'var(--amber)'}} /> Prep Checklist</div>
                {(tracker?.checklist || DEFAULT_CHECKLISTS[stage] || []).map((item, i) => {
                  const c = typeof item === 'string' ? { text: item, done: false } : item;
                  return (
                    <div key={i} className={`mc-checklist-item ${c.done ? 'done' : ''}`}>
                      <div className={`checkbox ${c.done ? 'checked' : ''}`} onClick={() => { ensureTracker(); toggleCheckItem(i); }} style={{cursor:'pointer'}} />
                      <span style={{flex:1}}>{c.text}</span>
                      {tracker && <button onClick={() => removeCheckItem(i)} style={{background:'none',border:'none',color:'var(--text-muted)',cursor:'pointer',opacity:0.5,fontSize:14}}>&times;</button>}
                    </div>
                  );
                })}
                <div className="mc-add-item">
                  <input value={newCheckItem} onChange={e => setNewCheckItem(e.target.value)} placeholder="Add prep item..." onKeyDown={e => e.key === 'Enter' && addCheckItem()} />
                  <button className="btn btn-primary" style={{padding:'6px 14px',fontSize:12}} onClick={addCheckItem}>Add</button>
                </div>
              </div>

              {/* Interview Tips */}
              {companyTips.length > 0 && (
                <div className="mc-section">
                  <div className="mc-section-title"><Icons.messageCircle style={{width:14,height:14,color:'var(--cyan)'}} /> Interview Tips ({companyTips.length})</div>
                  {companyTips.map((t, i) => (
                    <div key={i} className="intel-tip" style={{marginBottom:8}}>{t.text}<div className="source">Source: {t.source}</div></div>
                  ))}
                </div>
              )}

              {/* Notes */}
              <div className="mc-section">
                <div className="mc-section-title"><Icons.fileText style={{width:14,height:14,color:'var(--violet)'}} /> Notes</div>
                <textarea className="mc-notes" value={tracker?.notes || ''} onChange={e => { ensureTracker(); updateNotes(e.target.value); }} placeholder="Recruiter name, referral contacts, prep thoughts..." />
              </div>

              {/* Timeline */}
              <div className="mc-section">
                <div className="mc-section-title"><Icons.calendar style={{width:14,height:14,color:'var(--text-muted)'}} /> Timeline</div>
                {(tracker?.timeline || []).map((t, i) => (
                  <div key={i} className="mc-timeline-item">
                    <div className="mc-timeline-dot" />
                    <span className="mc-timeline-date">{t.date?.split('T')[0]}</span>
                    <span className="mc-timeline-event">{t.event}</span>
                  </div>
                ))}
                <div className="mc-add-timeline">
                  <input style={{flex:1,background:'var(--bg-surface)',border:'1px solid var(--border)',borderRadius:'var(--radius-sm)',padding:'6px 10px',color:'var(--text)',fontFamily:'var(--font-display)',fontSize:12,outline:'none'}} value={newTimelineEvent} onChange={e => setNewTimelineEvent(e.target.value)} placeholder="Add event..." onKeyDown={e => e.key === 'Enter' && addTimelineEvent()} />
                  <button className="btn btn-secondary" style={{padding:'6px 12px',fontSize:11}} onClick={addTimelineEvent}>Add</button>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="mc-actions">
                {selected.url && <a href={selected.url} target="_blank" rel="noopener" className="btn btn-link" style={{textDecoration:'none',display:'inline-flex',alignItems:'center',gap:6,fontSize:13}}><Icons.externalLink style={{width:14,height:14}} /> View Posting</a>}
                {selected.url && stage === 'discovered' && <button className="btn btn-primary" style={{fontSize:13,display:'flex',alignItems:'center',gap:6}} onClick={() => { setStage('applied'); window.open(selected.url, '_blank'); }}><Icons.send style={{width:14,height:14}} /> Apply</button>}
              </div>
            </>
          ) : (
            <div className="intel-right-empty">Select a role to view details</div>
          )}
        </div>
      </div>
    </>
  );
}
```

---

### Task 4: Verify and Test

- [ ] **Step 1: Restart the server**

```bash
lsof -ti :3847 | xargs kill; sleep 1 && node server.js &
```

- [ ] **Step 2: Navigate to Intel page in browser**

Open http://localhost:3847 and click "Intel" in the sidebar. Verify:
- Two-panel layout loads
- Left panel shows all 11 roles from intel data
- Filter tabs work (All, Active, Applied, Interview, Archive)
- Clicking a role shows mission control in right panel

- [ ] **Step 3: Test stage stepper**

Click stage dots to advance a role through the pipeline. Verify:
- Stage changes persist (refresh page, stage stays)
- Default checklist items added for new stage
- Timeline auto-logs "Stage changed to X"

- [ ] **Step 4: Test checklist**

Add a custom checklist item, check/uncheck items, remove items. Verify changes persist after refresh.

- [ ] **Step 5: Test notes**

Type in the notes area. Wait 1 second. Refresh. Verify notes persisted.

- [ ] **Step 6: Test timeline**

Add a manual timeline event. Verify it appears with today's date.

- [ ] **Step 7: Test action buttons**

Click "View Posting" — should open job URL in new tab. For a "Discovered" role, click "Apply" — should advance stage to Applied and open URL.
