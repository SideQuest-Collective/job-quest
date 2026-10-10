// app/lib/workbook/routes.js
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { researchAccepted } = require('./steps-prepare');
const { buildExportHtml } = require('./export');

function jobSummary(queue, id) {
  const jobs = queue.list().filter((j) => j.payload && j.payload.workbookId === id);
  if (!jobs.length) return null;
  const j = jobs.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a));
  return { id: j.id, status: j.status, mode: (j.payload && j.payload.mode) || 'create', progress: j.progress || null, error: j.error || null };
}

function listItem(dataDir, queue, meta) {
  const state = store.readJob(dataDir, meta.id);
  const failedChapters = state ? Object.values(state.chapters || {}).filter((c) => c.status === 'failed').length : 0;
  return {
    ...meta,
    ...store.summary(dataDir, meta.id),
    failedChapters,
    unreviewedChapters: meta.unreviewedChapters || 0,
    step: state && state.status === 'running' ? state.current : null,
    job: jobSummary(queue, meta.id),
  };
}

function registerWorkbookRoutes(app, { dataDir, queue, autoBuild, publicDir }) {
  const viewerFile = path.join(publicDir, 'workbook.html');
  const load = (req, res) => {
    const id = String(req.params.id || '');
    const meta = store.isValidId(id) ? store.readMeta(dataDir, id) : null;
    if (!meta) { res.status(404).json({ error: 'workbook not found' }); return null; }
    return meta;
  };
  const enqueueMode = (id, mode, key) => {
    const prior = store.readMeta(dataDir, id);
    // enqueue starts an idle handler synchronously. Never overwrite its status
    // after it has started, including when an onsite expansion follows create.
    const running = queue.list().some((j) => j.payload && j.payload.workbookId === id && j.status === 'running');
    if (!running) store.writeMeta(dataDir, { ...prior, status: 'queued' });
    const result = queue.enqueue({ kind: 'workbook', key, payload: { workbookId: id, mode } });
    if (result.status === 'duplicate' || (!running && result.status === 'deferred')) {
      store.writeMeta(dataDir, { ...store.readMeta(dataDir, id), status: result.status === 'duplicate' ? prior.status : result.status });
    }
    return result;
  };

  app.get('/api/workbooks', (req, res) => {
    res.json(store.listWorkbooks(dataDir).map((m) => listItem(dataDir, queue, m)));
  });

  app.get('/api/workbooks/backfill', (req, res) => {
    res.json({ candidates: autoBuild.backfillCandidates() });
  });

  app.post('/api/workbooks/backfill', (req, res) => {
    res.json({ results: autoBuild.backfill() });
  });

  app.post('/api/workbooks', (req, res) => {
    const { roleKey, tier, research } = req.body || {};
    if (typeof roleKey !== 'string' || !roleKey.includes('|')) {
      res.status(400).json({ error: 'roleKey must look like "Company|Role"' });
      return;
    }
    if (research != null && (typeof research !== 'string' || !researchAccepted(research, false))) {
      res.status(400).json({ error: 'research must be markdown with a "## Sources" section that lists at least one http(s) link' });
      return;
    }
    const r = autoBuild.enqueueWorkbook(roleKey, { trigger: 'manual', research: research || null });
    if (tier === 'onsite' && r.status === 'queued') enqueueMode(r.workbook.id, 'expand', `workbook:${r.workbook.id}:expand`);
    // An existing workbook keeps its own research; say so rather than silently dropping it.
    res.status(r.status === 'exists' ? 200 : 201).json(r.status === 'exists' && research ? { ...r, researchIgnored: true } : r);
  });

  app.get('/api/workbooks/:id', (req, res) => {
    const meta = load(req, res);
    if (meta) res.json(meta);
  });

  app.get('/api/workbooks/:id/job', (req, res) => {
    const meta = load(req, res);
    if (meta) res.json({ state: store.readJob(dataDir, meta.id), queue: jobSummary(queue, meta.id) });
  });

  app.get('/api/workbooks/:id/content', (req, res) => {
    const meta = load(req, res);
    if (meta) res.json({ meta, content: store.viewerContent(dataDir, meta.id) });
  });

  app.get('/api/workbooks/:id/progress', (req, res) => {
    const meta = load(req, res);
    if (meta) res.json(store.readProgress(dataDir, meta.id));
  });

  app.put('/api/workbooks/:id/progress', (req, res) => {
    const meta = load(req, res);
    if (!meta) return;
    const body = req.body || {};
    try {
      const current = store.readProgress(dataDir, meta.id);
      // Old clients may add answers or grades, but cannot replace an existing
      // response without a revision. Reloading loads the updated viewer.
      if (body.expectedRevision === undefined && ['answers', 'notes'].some(key => Object.entries(body[key] || {}).some(([qid, value]) => typeof value === 'string' && typeof current[key][qid] === 'string' && current[key][qid] !== value))) {
        return res.status(409).json({error:'Reload the updated workbook before replacing saved answers. Your browser draft is preserved.',current});
      }
      res.json(store.writeProgress(dataDir, meta.id, body));
    } catch (error) {
      res.status(error.status || 500).json({error:error.status ? error.message : 'Workbook progress could not be saved. Your existing answers were preserved.', ...(error.current ? {current:error.current} : {})});
    }
  });

  app.post('/api/workbooks/:id/expand', (req, res) => {
    const meta = load(req, res);
    if (!meta) return;
    if (meta.tier === 'onsite') { res.status(409).json({ error: 'this workbook is already onsite depth' }); return; }
    if (!['ready', 'partial'].includes(meta.status)) { res.status(409).json({ error: 'finish building the screen workbook first' }); return; }
    res.status(202).json(enqueueMode(meta.id, 'expand', `workbook:${meta.id}:expand`));
  });

  app.post('/api/workbooks/:id/retry', (req, res) => {
    const meta = load(req, res);
    if (!meta) return;
    const state = store.readJob(dataDir, meta.id);
    const failed = state ? Object.values(state.chapters || {}).filter((c) => c.status === 'failed') : [];
    let r;
    if (failed.length) r = enqueueMode(meta.id, 'retry', `workbook:${meta.id}:retry`);
    else if (meta.status === 'failed') r = enqueueMode(meta.id, 'create', `workbook:${meta.id}`);
    else { res.status(409).json({ error: 'nothing to retry' }); return; }
    res.status(202).json(r);
  });

  app.delete('/api/workbooks/:id', (req, res) => {
    const meta = load(req, res);
    if (!meta) return;
    if (queue.list().some((j) => j.payload && j.payload.workbookId === meta.id && ['running', 'queued', 'deferred'].includes(j.status))) {
      res.status(409).json({ error: 'this workbook is being generated; try again when it finishes' });
      return;
    }
    store.deleteWorkbook(dataDir, meta.id);
    res.json({ deleted: true });
  });

  app.get('/api/workbooks/:id/export', (req, res) => {
    const meta = load(req, res);
    if (!meta) return;
    const html = buildExportHtml(fs.readFileSync(viewerFile, 'utf-8'), {
      meta, content: store.viewerContent(dataDir, meta.id), progress: store.readProgress(dataDir, meta.id), exportedAt: new Date().toISOString(),
    });
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${meta.id}.html"`);
    res.send(html);
  });

  app.get('/workbooks/:id', (req, res) => {
    const id = String(req.params.id || '');
    if (!store.isValidId(id) || !store.readMeta(dataDir, id)) { res.status(404).send('Workbook not found'); return; }
    // Relative path + root: `send` 404s absolute paths that pass through a dot directory (~/.job-quest).
    res.sendFile(path.basename(viewerFile), { root: path.dirname(viewerFile) }, (err) => {
      if (err && !res.headersSent) res.status(err.status || 500).send('Could not load the workbook viewer');
    });
  });
}

function getWorkbookSdTopics(dataDir) {
  const topics = [];
  for (const meta of store.listWorkbooks(dataDir)) {
    for (const q of store.loadParsed(dataDir, meta.id).questions) {
      if (!store.isSystemDesign(q)) continue;
      const first = q.body.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) || q.id;
      topics.push({
        id: store.sdTopicId(meta.id, q.id),
        title: first.length > 120 ? `${first.slice(0, 117)}…` : first,
        description: q.body,
        source: 'workbook',
        sourceRoleKey: (meta.roleKeys || [])[0] || null,
        sourceCompany: meta.company || '',
        sourceRole: meta.role || '',
        workbookId: meta.id,
        qid: q.id,
        keyTopics: [],
        evaluationCriteria: String(q.rubric || '').split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean),
      });
    }
  }
  return topics;
}

module.exports = { registerWorkbookRoutes, jobSummary, getWorkbookSdTopics };
