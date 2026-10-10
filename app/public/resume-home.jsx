/* Regular resumes remain usable as originals; AI imports are reviewed before saving. */
window.ResumeHome = function ResumeHome({ onOpenLatex, onOpenMaster, active = true }) {
  const { useState, useEffect, useRef } = React;
  const [files, setFiles] = useState([]), [selected, setSelected] = useState('');
  const [master, setMaster] = useState(null), [runtime, setRuntime] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState('');
  const [error, setError] = useState(''), [status, setStatus] = useState('');
  const [proposal, setProposal] = useState(null), [reviewed, setReviewed] = useState(false);
  const fileInput = useRef(null), reviewSection = useRef(null), inFlight = useRef(false);
  const request = async (url, method = 'GET', body) => {
    const response = await fetch(url, { method, cache: 'no-store', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw Error([data.error || 'The request could not be completed.', ...(data.errors || [])].join(' '));
    return data;
  };
  const usable = list => (list || []).filter(file => /\.(pdf|docx|txt|md|tex)$/i.test(file.name)).sort((a, b) => b.modified.localeCompare(a.modified));
  const refresh = async (preferred) => {
    setLoading(true);
    const results = await Promise.allSettled([request('/api/resume/files'), request('/api/resume/master'), request('/api/runtime')]);
    const failures = [];
    if (results[0].status === 'fulfilled') {
      const next = usable(results[0].value.files); setFiles(next);
      setSelected(current => next.some(file => file.name === preferred) ? preferred : next.some(file => file.name === current) ? current : (next.find(file => /\.pdf$/i.test(file.name)) || next[0])?.name || '');
    } else failures.push('Original files: ' + results[0].reason.message);
    if (results[1].status === 'fulfilled') setMaster(results[1].value);
    else failures.push('Saved resume: ' + results[1].reason.message);
    if (results[2].status === 'fulfilled' && results[2].value.displayName) setRuntime(results[2].value.displayName);
    else { setRuntime(''); failures.push('AI provider could not be identified. Reload before importing. ' + (results[2].status === 'rejected' ? results[2].reason.message : 'No provider is configured.')); }
    if (failures.length) setError(failures.join(' '));
    setLoading(false);
  };
  // Refresh shared saved data when this retained page becomes visible again.
  // The unsaved import proposal remains separate and is never replaced here.
  useEffect(() => {
    if (!active) return;
    const reload = () => { if (!inFlight.current && document.visibilityState !== 'hidden') refresh(); };
    reload();
    window.addEventListener('focus', reload);
    document.addEventListener('visibilitychange', reload);
    return () => { window.removeEventListener('focus', reload); document.removeEventListener('visibilitychange', reload); };
  }, [active]);
  useEffect(() => {
    if (!proposal && !busy) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [proposal, busy]);
  const hasMaster = Boolean(master && (master.contact?.name || master.summary || master.experience?.length || master.education?.length || master.additionalSections?.length));
  const fileUrl = selected ? '/api/resume/file/' + selected.split('/').map(encodeURIComponent).join('/') : '';
  const leave = callback => { if (!proposal || window.confirm('Discard the unsaved import review? Your original file will stay saved.')) callback(); };
  const upload = async event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || inFlight.current) return;
    setError(''); setStatus('');
    if (!/\.(pdf|docx|txt|md)$/i.test(file.name)) { setError('Choose a PDF, Word .docx, text, or Markdown file. For an older .doc file, save it as .docx or PDF first.'); return; }
    if (file.size > 10 * 1024 * 1024) { setError('This file is too large. Choose a resume smaller than 10 MB.'); return; }
    inFlight.current = true; setBusy('upload');
    try {
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(Error('Could not read this file. Try selecting it again.')); reader.readAsDataURL(file); });
      const result = await request('/api/resume/upload', 'POST', { filename: file.name, data, type: file.type });
      await refresh(result.filename); setStatus('Original saved. You can open it now or import an editable version.');
    } catch (cause) { setError(cause.message); }
    finally { inFlight.current = false; setBusy(''); }
  };
  const importSelected = async () => {
    if (!selected || !runtime || inFlight.current) return;
    if (proposal && !window.confirm('Replace the unsaved import review with a new draft?')) return;
    inFlight.current = true; setBusy('import'); setError(''); setStatus('Reading your resume with ' + runtime + '. This can take a few minutes.');
    try {
      const result = await request('/api/resume/master/import-file', 'POST', { filename: selected });
      if (!result.proposed || typeof result.proposed !== 'object' || Array.isArray(result.proposed)) throw Error('The import did not return a usable resume. Your original is still saved; try again.');
      setProposal(result); setReviewed(false); setStatus('Import ready for your review. Nothing has replaced your saved resume.');
      setTimeout(() => reviewSection.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
    } catch (cause) { setError(cause.message); setStatus(''); }
    finally { inFlight.current = false; setBusy(''); }
  };
  const patchProposal = (path, value) => {
    setProposal(current => {
      const next = JSON.parse(JSON.stringify(current)); let target = next.proposed;
      for (const key of path.slice(0, -1)) target = target[key];
      target[path[path.length - 1]] = value; return next;
    });
    setReviewed(false);
  };
  const save = async () => {
    if (!reviewed || !proposal || inFlight.current) return;
    inFlight.current = true; setBusy('save'); setError(''); setStatus('');
    try {
      const saved = await request('/api/resume/master', 'PUT', proposal.proposed);
      setMaster(saved); setProposal(null); setReviewed(false); setStatus('Reviewed resume saved. You can now edit it or download a LaTeX version.');
    } catch (cause) { setError(cause.message); }
    finally { inFlight.current = false; setBusy(''); }
  };
  return <div className="resume-home">
    <style>{`
      .resume-home{padding:28px;max-width:1120px;width:100%;margin:0 auto;min-width:0;color:var(--text)}
      .resume-home h2,.resume-home h3,.resume-home h4,.resume-home h5{text-transform:none;letter-spacing:0;font-family:inherit}.resume-home h2{font-size:30px;line-height:1.2;margin:0 0 12px}.resume-home h3{font-size:20px;margin:0 0 10px}.resume-home p{color:var(--text-secondary);margin:8px 0 16px}
      .resume-home .card{margin-bottom:20px}.resume-home .rh-actions{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}.resume-home .rh-actions .btn{padding:10px 16px}
      .resume-home .rh-file-row{display:flex;gap:14px;align-items:end;flex-wrap:wrap}.resume-home .rh-file-row label{flex:1;min-width:180px}.resume-home label{display:block;font-size:15px}
      .resume-home select,.resume-home input:not([type=checkbox]),.resume-home textarea{display:block;width:100%;min-width:0;margin-top:6px;padding:10px;border:1px solid var(--border);border-radius:7px;background:var(--bg-deep);color:var(--text);font-size:16px}
      .resume-home select{min-height:46px}.resume-home textarea{min-height:90px;resize:vertical;line-height:1.5}.resume-home button:disabled{opacity:.55;cursor:wait}
      .resume-home .rh-note{font-size:14px;color:var(--text-muted)}.resume-home .rh-status{padding:14px;border:1px solid var(--border);margin:12px 0;overflow-wrap:anywhere}.resume-home .rh-error{border-color:var(--amber)}
      .resume-home .rh-pdf-preview{border:1px solid var(--border);border-radius:6px;overflow:hidden;background:var(--bg-deep)}.resume-home .rh-pdf-preview canvas{display:block;width:100%;height:auto;background:white}.resume-home .rh-pdf-preview .rh-status{margin:0;border:0}.resume-home summary{padding:12px 0;font-weight:600}.resume-home details{margin:8px 0}
      .resume-home .rh-document{background:#fff;color:#172133;border-radius:7px;padding:30px;line-height:1.65;overflow-wrap:anywhere}.resume-home .rh-document p{color:inherit;white-space:pre-wrap}.resume-home .rh-document h3{color:#172133;font-size:24px;margin:0 0 8px}.resume-home .rh-document h4{font-size:17px;border-bottom:1px solid #d5dce4;margin:22px 0 10px;padding-bottom:5px}.resume-home .rh-document h5{font-size:16px;margin:14px 0 4px}.resume-home .rh-document ul{padding-left:22px;margin:6px 0 14px}.resume-home .rh-document .rh-muted{color:#556278;font-size:14px}
      .resume-home .rh-edit-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.resume-home .rh-edit-wide{grid-column:1/-1}.resume-home fieldset{border:1px solid var(--border);padding:14px;border-radius:7px;margin:14px 0;min-width:0}.resume-home legend{font-weight:600;padding:0 5px}.resume-home .rh-checkbox{display:flex;align-items:flex-start;gap:12px;margin:20px 0}.resume-home .rh-checkbox input{width:22px;height:22px;flex-shrink:0;accent-color:var(--amber);margin-top:2px}
      .resume-home .rh-review{scroll-margin-top:90px;border-top:3px solid var(--amber)}.resume-home .rh-warning-list{padding-left:22px;color:var(--text-secondary)}
      @media(max-width:768px){.resume-home{padding:4px 0 24px}.resume-home h2{font-size:27px}.resume-home .rh-document{padding:20px 16px}.resume-home .rh-edit-grid{grid-template-columns:1fr}.resume-home .rh-actions .btn{flex:1}.resume-home .rh-file-row{display:block}.resume-home .rh-file-row button{margin-top:12px;width:100%}.resume-home .rh-file-row label{min-width:0}.resume-home .rh-document h3{font-size:22px}}
    `}</style>
    <header><h2>Your resume</h2><p>View and edit your master resume here. Keep your original files for reference.</p></header>
    {error && <div className="rh-status rh-error" role="alert">{error}<div className="rh-actions"><button className="btn btn-secondary" disabled={!!busy} onClick={() => { setError(''); refresh(); }}>Reload saved files</button></div></div>}
    {status && <div className="rh-status" role="status">{status}</div>}
    {hasMaster && <section className="card"><h3>Master resume</h3><p>This is your saved, editable resume. Edit it below or download it as LaTeX. Job-specific tailoring is on Intel.</p><div className="rh-actions"><button className="btn btn-primary" disabled={!!busy} onClick={() => leave(onOpenMaster)}>Edit saved resume</button><a className="btn btn-secondary" href="/api/resume/master/latex" download="resume.tex">Download LaTeX (.tex)</a></div><ResumeReadableDocument data={master} /><p className="rh-note">The LaTeX export uses a clean template; it may differ from your original layout.</p></section>}
    <section className="card" aria-busy={!!busy}>
      <h3>Your original file</h3>
      <p>{loading ? 'Loading your saved resumes…' : files.length ? 'Your original stays available even if you create or edit another version.' : 'No resume has been added to this local Job Quest yet. Upload yours to see it here.'}</p>
      <input ref={fileInput} type="file" accept=".pdf,.docx,.txt,.md" onChange={upload} style={{ display: 'none' }} aria-label="Choose resume file" />
      <div className="rh-file-row">
        {files.length > 0 && <label>Original file<select value={selected} disabled={!!busy} onChange={event => { setSelected(event.target.value); setStatus(''); }}>{files.map(file => <option key={file.name} value={file.name}>{file.name}</option>)}</select></label>}
        <button className="btn btn-primary" disabled={!!busy || loading} onClick={() => fileInput.current?.click()}>{busy === 'upload' ? 'Saving original…' : files.length ? 'Add another resume' : 'Upload your resume'}</button>
      </div>
      <p className="rh-note">PDF, Word (.docx), text, or Markdown · Up to 10 MB</p>
      {selected && <>
        <div className="rh-actions"><a className="btn btn-secondary" href={fileUrl} target="_blank" rel="noopener noreferrer">Open original</a><a className="btn btn-secondary" href={fileUrl} download={selected.split('/').pop()}>Download original</a>{!hasMaster && <button className="btn btn-primary" disabled={!!busy || !runtime} onClick={importSelected}>{busy === 'import' ? 'Creating review draft…' : 'Create editable copy'}</button>}</div>
        {hasMaster ? <details><summary>Replace master from an original file</summary><p>Use this only when you have an updated original. {runtime || 'Your AI provider'} creates an editable draft from its text. Review it before saving; saving replaces your current master and keeps the original file.</p><button className="btn btn-secondary" disabled={!!busy || !runtime} onClick={importSelected}>{busy === 'import' ? 'Creating review draft…' : 'Create draft from this file'}</button></details> : <p className="rh-note">{runtime ? <>Create editable copy uses {runtime} to turn this file’s text into editable resume fields. You review it before saving. Your original stays unchanged.</> : <>Creating an editable copy is unavailable until your AI provider is identified. You can still open or download your original.</>}</p>}
        {/\.pdf$/i.test(selected) ? <details open={hasMaster ? undefined : true}><summary>Preview original PDF</summary><ResumeOriginalPdf key={selected} url={fileUrl} filename={selected} /></details> : <p>Open or download your source file above. Import it to read and edit its contents here.</p>}
      </>}
    </section>
    {proposal && <section className="card rh-review" ref={reviewSection}>
      <h3>Review your import</h3><p>From {proposal.source?.filename || selected}. Check the wording, dates, contact details, and anything the importer may have missed against your original.</p>
      {hasMaster && <p><strong>Saving this review replaces your current editable resume.</strong> Your original files stay saved.</p>}
      {proposal.warnings?.length > 0 && <ul className="rh-warning-list">{proposal.warnings.map((warning, i) => <li key={i}>{String(warning)}</li>)}</ul>}
      {proposal.errors?.length > 0 && <div className="rh-status rh-error"><strong>Some imported fields need attention.</strong><ul className="rh-warning-list">{proposal.errors.map((message, i) => <li key={i}>{String(message)}</li>)}</ul><p className="rh-note">Correct these below. Saving will validate your edited version again.</p></div>}
      <ResumeReadableDocument data={proposal.proposed} />
      <details open={proposal.errors?.length ? true : undefined}><summary>Edit imported details</summary><p className="rh-note">Use YYYY-MM for employment dates; leave the end date blank for a current role. Education dates can use just the year.</p><ResumeImportFields data={proposal.proposed} patch={patchProposal} disabled={!!busy} /></details>
      <label className="rh-checkbox"><input type="checkbox" checked={reviewed} disabled={!!busy} onChange={event => setReviewed(event.target.checked)} /><span>I checked the imported facts against my original{hasMaster ? ' and want to replace the editable resume' : ''}.</span></label>
      <div className="rh-actions"><button className="btn btn-primary" disabled={!reviewed || !!busy} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save reviewed resume'}</button><button className="btn btn-secondary" disabled={!!busy} onClick={() => { if (window.confirm('Discard this import review? Your original file will stay saved.')) { setProposal(null); setReviewed(false); setStatus('Review discarded. Your original is still saved.'); } }}>Discard review</button></div>
    </section>}
    {!loading && master && !hasMaster && !proposal && <section className="card"><h3>No editable resume yet</h3><p>An editable master keeps your reviewed facts in one place for tailoring and LaTeX export. Your original file remains separate.</p><p>{selected ? 'Choose Create editable copy above, then review and save the result to create yours.' : 'Upload your resume above to import it, or create one manually below.'}</p></section>}
    <details><summary>More resume tools</summary><p>Create a master by hand or work with LaTeX source files.</p><div className="rh-actions"><button className="btn btn-secondary" disabled={!!busy} onClick={() => leave(onOpenMaster)}>{hasMaster ? 'Master resume editor' : 'Create resume manually'}</button><button className="btn btn-secondary" disabled={!!busy} onClick={() => leave(onOpenLatex)}>LaTeX workspace</button></div></details>
  </div>;
};

function ResumeReadableDocument({ data }) {
  const array = value => Array.isArray(value) ? value : [];
  const text = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const dates = (start, end) => [text(start), end === null ? 'Present' : text(end)].filter(Boolean).join(' – ');
  const bullets = list => array(list).length ? <ul>{array(list).map((bullet, i) => <li key={i}>{text(bullet?.text || bullet)}</li>)}</ul> : null;
  const c = data.contact || {};
  return <article className="rh-document" aria-label="Resume content">
    <h3>{text(c.name) || 'Name not provided'}</h3>
    <p className="rh-muted">{[c.email, c.phone, c.location, c.linkedin, ...array(c.links)].map(text).filter(Boolean).join(' · ')}</p>
    {data.headline && <strong>{text(data.headline)}</strong>}{data.summary && <p>{text(data.summary)}</p>}
    {array(data.experience).length > 0 && <><h4>Experience</h4>{data.experience.map((job, i) => <section key={i}><h5>{text(job.employer)}</h5>{job.location && <div className="rh-muted">{text(job.location)}</div>}<div className="rh-muted">{dates(job.start, job.end)}</div>{array(job.roles).map((role, j) => <div key={j}><strong>{text(role.title)}{role.team ? ' · ' + text(role.team) : ''}</strong><div className="rh-muted">{dates(role.start, role.end)}</div>{bullets(role.bullets)}</div>)}</section>)}</>}
    {array(data.projects).length > 0 && <><h4>Projects</h4>{data.projects.map((project, i) => <section key={i}><h5>{text(project.name)}</h5><div className="rh-muted">{array(project.tech).map(text).join(', ')}</div>{bullets(project.bullets)}</section>)}</>}
    {array(data.skills).length > 0 && <><h4>Skills</h4>{data.skills.map((group, i) => <p key={i}>{group.group && <strong>{text(group.group)}: </strong>}{array(group.items).map(text).join(', ')}</p>)}</>}
    {array(data.education).length > 0 && <><h4>Education</h4>{data.education.map((education, i) => <p key={i}><strong>{text(education.school)}</strong><br />{text(education.degree)}<br /><span className="rh-muted">{dates(education.start, education.end)}</span></p>)}</>}
    {array(data.certifications).length > 0 && <><h4>Certifications</h4>{data.certifications.map((certificate, i) => <p key={i}>{text(certificate.name)}{certificate.date ? ' · ' + text(certificate.date) : ''}</p>)}</>}
    {array(data.additionalSections).map((section, i) => <section key={i}><h4>{text(section.title)}</h4><p>{text(section.body)}</p></section>)}
  </article>;
}

function ResumeImportFields({ data, patch, disabled }) {
  const hidden = new Set(['version', 'meta', 'id', 'variantOf']);
  const labels = { contact: 'Contact details', name: 'Name', email: 'Email', phone: 'Phone', linkedin: 'LinkedIn', location: 'Location', links: 'Other links (one per line)', headline: 'Headline', summary: 'Summary', experience: 'Experience', employer: 'Employer', roles: 'Roles', title: 'Role title', team: 'Team', start: 'Start date', end: 'End date', bullets: 'Achievements', text: 'Achievement', projects: 'Projects', tech: 'Technologies (one per line)', skills: 'Skills', group: 'Skill group', items: 'Skills (one per line)', education: 'Education', school: 'School', degree: 'Degree', certifications: 'Certifications', date: 'Date', additionalSections: 'Additional sections', body: 'Section content' };
  const render = (value, path, label) => {
    const key = path.join('.');
    if (Array.isArray(value)) {
      if (!value.length) return null;
      if (value.every(item => typeof item === 'string')) return <label key={key} className="rh-edit-wide">{label}<textarea disabled={disabled} value={value.join('\n')} onChange={event => patch(path, event.target.value.split('\n'))} /></label>;
      return <fieldset key={key} className="rh-edit-wide"><legend>{label}</legend>{value.map((item, index) => <fieldset key={index}><legend>{item?.employer || item?.title || item?.name || item?.school || `${index + 1}`}</legend>{render(item, [...path, index], '')}</fieldset>)}</fieldset>;
    }
    if (value && typeof value === 'object') return <div key={key} className="rh-edit-grid">{Object.entries(value).filter(([name]) => !hidden.has(name)).map(([name, child]) => render(child, [...path, name], name === 'title' && path[0] === 'additionalSections' ? 'Section title' : labels[name] || name))}</div>;
    const multiline = ['summary', 'text', 'body'].includes(path[path.length - 1]);
    const update = event => patch(path, event.target.value === '' && path[path.length - 1] === 'end' && path[0] === 'experience' ? null : event.target.value);
    return <label key={key} className={multiline ? 'rh-edit-wide' : ''}>{label}{multiline ? <textarea disabled={disabled} value={value ?? ''} onChange={update} /> : <input disabled={disabled} value={value ?? ''} onChange={update} />}</label>;
  };
  return <div className="rh-edit-grid">{Object.entries(data).filter(([key]) => !hidden.has(key)).map(([key, value]) => <div key={key} className="rh-edit-wide">{key === 'contact' ? <fieldset><legend>Contact details</legend>{render(value, [key], labels[key])}</fieldset> : render(value, [key], labels[key] || key)}</div>)}</div>;
}


function ResumeOriginalPdf({ url, filename }) {
  const canvas = React.useRef(null);
  const [state, setState] = React.useState({ loading: true, pages: 0, error: '' });
  React.useEffect(() => {
    let disposed = false, loadingTask = null, rendering = null;
    setState({ loading: true, pages: 0, error: '' });
    const preview = async () => {
      try {
        if (!window.pdfjsLib) throw Error('The PDF preview could not load.');
        // Request ranges on demand; render just the first page rather than every page.
        loadingTask = window.pdfjsLib.getDocument({ url, disableAutoFetch: true, disableStream: true, rangeChunkSize: 65536 });
        const pdf = await loadingTask.promise;
        if (disposed) return;
        const page = await pdf.getPage(1);
        if (disposed || !canvas.current) return;
        const natural = page.getViewport({ scale: 1 });
        const visibleWidth = canvas.current.parentElement?.clientWidth || 800;
        const pixels = Math.min(1800, Math.max(900, visibleWidth * Math.min(window.devicePixelRatio || 1, 2)));
        const viewport = page.getViewport({ scale: pixels / natural.width });
        const surface = canvas.current;
        surface.width = Math.ceil(viewport.width); surface.height = Math.ceil(viewport.height);
        rendering = page.render({ canvasContext: surface.getContext('2d'), viewport });
        await rendering.promise;
        if (!disposed) setState({ loading: false, pages: pdf.numPages, error: '' });
      } catch (cause) {
        if (!disposed) setState({ loading: false, pages: 0, error: 'The PDF preview is unavailable. Open the original to read your resume.' });
      }
    };
    preview();
    return () => {
      disposed = true;
      if (rendering) rendering.cancel();
      if (loadingTask) Promise.resolve(loadingTask.destroy()).catch(() => {});
    };
  }, [url]);
  return <div>
    <div className="rh-pdf-preview" aria-busy={state.loading}>
      {state.loading && <p className="rh-status" role="status">Loading the first page…</p>}
      {state.error && <div className="rh-status" role="status"><p>{state.error}</p><a href={url} target="_blank" rel="noopener noreferrer">Open original PDF</a></div>}
      <canvas ref={canvas} hidden={state.loading || !!state.error} style={{ display: state.loading || state.error ? 'none' : 'block' }} role="img" aria-label={'First page of ' + filename + '. Open the original for selectable text and all pages.'} />
    </div>
    {!state.loading && !state.error && <p className="rh-note">Page 1 of {state.pages}. <a href={url} target="_blank" rel="noopener noreferrer">Open the original PDF</a> for full-size reading{state.pages > 1 ? ' and all pages' : ''}.</p>}
  </div>;
}
