const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm');
const {mergeAssistance}=require('../lib/feedback/assistance');
const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8'),html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jq-beh-help-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function routes(dir){fs.mkdirSync(path.join(dir,'behavioral'));const handlers=new Map();vm.runInNewContext(source.slice(source.indexOf("app.post('/api/evaluate-answer'"),source.indexOf('// --- Behavioral Draft Generation ---')),{app:{post(url,fn){handlers.set(url,fn);},get(){}},feedbackRoute:fn=>fn,feedbackService:{submit(_kind,body){return {attempt:{assistance:body.assistance}};}},mergeAssistance,DATA_DIR:dir,path,fs,safeId:key=>/^[a-z0-9_-]+$/.test(key),writeFeedbackJson(file,value){fs.writeFileSync(file,JSON.stringify(value));}});return (url,body)=>{const res={statusCode:200,status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};handlers.get(url)({body},res);return res;};}
test('Behavioral saves retain monotonic exposure and enforce stored evidence on review, including old clients',t=>{
 const dir=fixture(t),post=routes(dir);let result=post('/api/behavioral/answers',{key:'q',answer:'Fixture answer',expectedRevision:0,assistance:{revealed:true}});assert.equal(result.statusCode,200);
 result=post('/api/behavioral/answers',{key:'q',answer:'Edited',expectedRevision:1,assistance:{revealed:false,assisted:true}});assert.equal(result.body.answer.assistance.revealed,true);
 result=post('/api/behavioral/answers',{key:'q',answer:'Legacy edit',expectedRevision:2});assert.equal(result.body.answer.assistance.assisted,true);
 const before=fs.readFileSync(path.join(dir,'behavioral/answers.json'),'utf8');result=post('/api/behavioral/answers',{key:'q',answer:'Stale',expectedRevision:0,assistance:{revealed:false}});assert.equal(result.statusCode,409);assert.equal(fs.readFileSync(path.join(dir,'behavioral/answers.json'),'utf8'),before);
 const reviewed=post('/api/evaluate-answer',{key:'q',userAnswer:'Legacy edit',assistance:{assisted:false,revealed:false}});assert.equal(reviewed.body.attempt.assistance.revealed,true);assert.equal(reviewed.body.attempt.assistance.assisted,true);
 const learning=post('/api/evaluate-answer',{key:'q',source:'learning',assistance:{sourceHash:'abc',assisted:false}});assert.equal(learning.body.attempt.assistance.sourceHash,'abc');assert.equal(learning.body.attempt.assistance.assisted,false);
 assert.equal(mergeAssistance(null,null),null);
});
function browserHandlers(saved={}){
 const storage=new Map();const ctx={questions:[{key:'q',text:'Fixture question'}],answers:{q:'Fixture answer'},saveChains:{current:{}},revisions:{current:{q:0}},assistanceEvidence:{current:{}},saveTimer:{current:{}},feedback:{setReviewError() {},async refreshReviews(){}},evaluatingKey:null,draftMode:{},sessionStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},setAnswerAssistance(){},setRevealedFrameworks(){},setEvaluatingKey(){},setAnswers(){},setDraftMode(){},setDraftQuestions(){},setTimeout(){},clearTimeout(){},console,crypto:{randomUUID:()=> 'fixture_review'},resumeData:null,posted:[]};ctx.api={async post(url,body){ctx.posted.push({url,body});if(url.endsWith('generate-draft'))return {draft:'Generated fixture draft'};if(url.endsWith('answers'))return {revision:1};return {attempt:{answerRevision:2}};}};
 const start=html.indexOf('  const saveAnswer = (key, answer) => {',html.indexOf('function Behavioral()'));const end=html.indexOf('  const submitDraftResponses',start);vm.runInNewContext(html.slice(start,end)+'\nthis.handlers={recordHelp,revealGuidance,saveAnswer,submitForReview,generateDraft};',ctx);
 const restore=()=>{ctx.savedAnswers=saved;ctx.bqs=ctx.questions;ctx.restoredAnswers=ctx.answers;const a=html.indexOf('      const restoredHelp = {};',html.indexOf('function Behavioral()'));const b=html.indexOf('      setAnswers(restoredAnswers);',a);vm.runInNewContext(html.slice(a,b),ctx);};return {ctx,storage,restore};
}
test('actual Behavioral handlers persist reveal before hide/reload and review keeps exposure',async()=>{
 const b=browserHandlers();b.ctx.handlers.revealGuidance('q');await b.ctx.saveChains.current.q;assert.equal(b.ctx.posted[0].body.assistance.revealed,true);
 // Hiding changes only visibility; the separate stored evidence survives restoration.
 b.restore();assert.equal(b.ctx.assistanceEvidence.current.q.revealed,true);await b.ctx.handlers.submitForReview(b.ctx.questions[0]);assert.equal(b.ctx.posted.at(-1).body.assistance.revealed,true);
});
test('generated answer marks help before the scheduled save; saved evidence restores in another browser',async()=>{
 const b=browserHandlers();await b.ctx.handlers.generateDraft(b.ctx.questions[0]);await b.ctx.handlers.saveAnswer('q','Generated fixture draft');assert.equal(b.ctx.posted.at(-1).body.assistance.assisted,true);assert.equal(JSON.parse(b.storage.get('jq-behavioral-help-q')).assisted,true);
 const other=browserHandlers({q:{answer:'Generated fixture draft',assistance:{assisted:true,revealed:true}}});other.restore();assert.equal(other.ctx.assistanceEvidence.current.q.assisted,true);assert.equal(other.ctx.assistanceEvidence.current.q.revealed,true);
});
test('legacy answers with missing help metadata restore as unknown, not independent evidence',()=>{
 const old=browserHandlers({q:{answer:'Legacy answer'}});old.restore();assert.equal(old.ctx.assistanceEvidence.current.q,null);old.ctx.handlers.recordHelp('q',{revealed:true});assert.equal(old.ctx.assistanceEvidence.current.q.revealed,true);assert.equal(old.ctx.assistanceEvidence.current.q.assisted,undefined);
});
