const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;
const html = fs.readFileSync(path.resolve(__dirname, '../public/workbook.html'), 'utf8');
const existingHarness = fs.readFileSync(path.join(__dirname, 'workbook-viewer.test.js'), 'utf8');
// Reuse the native viewer's complete-IIFE harness, extending only its test
// inputs and returned private functions. Production code has no test hooks.
let helper = existingHarness.slice(existingHarness.indexOf('async function loadViewer('), existingHarness.indexOf("test('a viewer answer save"));
helper = helper.replace('putResponse } = {})', "putResponse, feedbackResponse, pathname='/workbooks/sample', referrer='' } = {})");
helper = helper.replace('const document = {', 'const document = { referrer,');
helper = helper.replace('document,\n    window:', 'document, crypto, TextEncoder, URL,\n    window:');
helper = helper.replace("location: { pathname: '/workbooks/sample', hash: '' }", "location: { pathname, hash: '', origin:'http://localhost:3847' }");
helper = helper.replace("requests.push(url);", "requests.push(url); if(url.startsWith('/api/feedback')||url==='/api/evaluate-answer') return feedbackResponse ? feedbackResponse(url,options) : {ok:true,json:async()=>({attempts:[]})};");
helper = helper.replace('viewSearch };', 'viewSearch, submitReview, loadReview, feedbackKey, REVIEWS, reviewMarkup };');
const loadViewer = new Function('vm', 'clone', 'html', 'assert', 'crypto', 'TextEncoder', 'URL', helper + '; return loadViewer;')(vm, value => JSON.parse(JSON.stringify(value)), html, assert, crypto, TextEncoder, URL);
const panel = () => ({ isConnected:true, innerHTML:'', querySelectorAll(){return [];} });
const done = (body, extra={}) => ({ id:body.attemptId, questionId:body.key, source:'workbook', answer:body.userAnswer, createdAt:'2026-10-09T10:00:00Z',status:'done',evaluation:{score:8,maxScore:10,feedback:'Clear answer.',strengths:['Specific'],improvements:['Mention limits']},...extra });
const response = value => ({ok:true,json:async()=>value});

test('written workbook review saves first, carries reference/help context and preserves grades/history', async () => {
  const calls=[];let submitted;
  const grade={grade:'partial',at:'2026-10-08T12:00:00Z',source:'trainer'};
  const viewer=await loadViewer({progress:{grades:{q1:grade}},putResponse:async body=>{calls.push('saved');assert.equal(body.answers.q1,'My answer');return {ok:true};},feedbackResponse:async(url,options)=>{
    calls.push('review'); submitted=JSON.parse(options.body); return response({attempt:done(submitted)});
  }});
  viewer.api.S.draft.q1='My answer';viewer.api.S.ans.q1.revealed=true;viewer.api.S.ans.q1.hintUsed=true;viewer.api.S.ans.q1.assisted=true;
  const q=viewer.api.QUESTIONS[0];q.answer='Reference answer';q.rubric='- Discuss limits';
  await viewer.api.submitReview(q,panel(),false);
  assert.deepEqual(calls,['saved','review']);assert.equal(submitted.userAnswer,'My answer');
  assert.equal(submitted.source,'workbook');assert.match(submitted.key,/^wb_[a-f0-9]{64}$/);
  assert.deepEqual(submitted.assistance,{assisted:true,revealed:true,hintUsed:true,workbookId:'sample',questionId:'q1'});
  assert.match(submitted.sampleAnswer,/Reference answer/);assert.match(submitted.sampleAnswer,/Discuss limits/);
  assert.deepEqual(viewer.puts[0].grades.q1,grade);assert.equal(viewer.api.S.ans.q1.s,'partial');
  assert.match(viewer.api.reviewMarkup(q),/8\/10/);assert.match(viewer.api.reviewMarkup(q),/self-grade/);
});
test('failed progress save prevents AI submission and preserves browser draft',async()=>{
  let reviews=0;const viewer=await loadViewer({feedbackResponse:async()=>{reviews++;return response({});}});
  viewer.api.S.draft.q1='Saved offline';viewer.failPut(true);
  await viewer.api.submitReview(viewer.api.QUESTIONS[0],panel(),false);
  assert.equal(reviews,0);assert.match(viewer.api.REVIEWS.q1.error,/Reconnect/);
  assert.equal(JSON.parse(viewer.storage.get('workbook.sample.pending')).answers.q1,'Saved offline');
});
test('unknown network outcome replays the same immutable submission after reload',async()=>{
  let first;
  const viewer=await loadViewer({feedbackResponse:async(url,options)=>{first=JSON.parse(options.body);throw new Error('Network offline');}});
  viewer.api.S.draft.q1='Original response';await viewer.api.submitReview(viewer.api.QUESTIONS[0],panel(),false);
  assert.ok(viewer.storage.has('workbook.sample.review-submissions'));
  let replay;
  const restored=await loadViewer({stored:Object.fromEntries(viewer.storage),feedbackResponse:async(url,options)=>{replay=JSON.parse(options.body);return response({attempt:done(replay)});}});
  restored.api.S.draft.q1='A newer draft';await restored.api.submitReview(restored.api.QUESTIONS[0],panel(),false);
  assert.equal(replay.attemptId,first.attemptId);assert.equal(replay.userAnswer,'Original response');
  assert.equal(restored.api.S.draft.q1,'A newer draft');assert.equal(restored.puts.length,0);
  assert.equal(restored.storage.has('workbook.sample.review-submissions'),false);
});
test('feedback reload filters source, retries the failed attempt and never creates a self-grade',async()=>{
  let key;const requests=[];
  const viewer=await loadViewer({feedbackResponse:async(url,options)=>{
    requests.push(url);
    if(!options)return response({attempts:[{...done({key,attemptId:'wrong-source'}),source:'learning'},done({key,attemptId:'saved-attempt'},{status:'failed',evaluation:undefined,error:'Coach unavailable'})]});
    return response({attempt:done({key,attemptId:'saved-attempt'},{status:'queued',evaluation:undefined})});
  }});
  const q=viewer.api.QUESTIONS[0];key=await viewer.api.feedbackKey(q);
  await viewer.api.loadReview(q,panel());assert.equal(viewer.api.REVIEWS.q1.attempt.id,'saved-attempt');
  assert.doesNotMatch(viewer.api.reviewMarkup(q),/0\/10/);assert.match(viewer.api.reviewMarkup(q),/Retry saved review/);
  await viewer.api.submitReview(q,panel(),true);
  assert.equal(requests[1],'/api/feedback/saved-attempt/retry');assert.equal(viewer.puts.length,0);
  assert.equal(viewer.api.S.ans.q1,undefined);assert.match(viewer.api.reviewMarkup(q),/Awaiting review/);
});
test('stable workbook keys distinguish same question IDs in separate workbooks',async()=>{
  const a=await loadViewer(),b=await loadViewer({pathname:'/workbooks/another'});
  const key=await a.api.feedbackKey(a.api.QUESTIONS[0]);
  assert.equal(await a.api.feedbackKey(a.api.QUESTIONS[0]),key);
  assert.notEqual(await b.api.feedbackKey(b.api.QUESTIONS[0]),key);
});
test('offline workbook makes no review requests and offers truthful reconnect guidance',async()=>{
  const viewer=await loadViewer({offline:true});
  viewer.api.S.draft.q1='Offline answer';await viewer.api.submitReview(viewer.api.QUESTIONS[0],panel(),false);
  await viewer.api.loadReview(viewer.api.QUESTIONS[0],panel());
  assert.equal(viewer.requests.length,0);assert.match(viewer.api.reviewMarkup(viewer.api.QUESTIONS[0]),/offline copy/);
});
test('Back target stays same-origin and otherwise falls back to workbook list',async()=>{
  const local=await loadViewer({referrer:'http://localhost:3847/?tab=practice'});
  assert.equal(local.elements.get('backJobQuest').href,'http://localhost:3847/?tab=practice#workbooks');
  const foreign=await loadViewer({referrer:'https://other.example/private'});
  assert.equal(foreign.elements.get('backJobQuest').href,'/#workbooks');
});
