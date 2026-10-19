const fs = require('fs');
const path = require('path');
const {spawn, execFile} = require('child_process');
const {promisify} = require('util');
const execute = promisify(execFile);
const {state:lockState}=require('./lock');
const {getLocalDateStamp}=require('../local-date');
const crypto=require('crypto');
function failure(message, status=400) {return Object.assign(new Error(message), {status});}
function scheduleCron(value) {
  if (!value || !['daily','weekdays','off'].includes(value.frequency)) throw failure('Choose daily, weekdays, or off.');
  if (value.frequency === 'off') return null;
  if (typeof value.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw failure('Choose a valid local time.');
  const [hour, minute] = value.time.split(':').map(Number);
  return `${minute} ${hour} * * ${value.frequency === 'daily' ? '*' : '1-5'}`;
}
function createIntelControls({dataDir, binDir, getRuntime, exec=execute, launch=spawn, now=()=>new Date()}={}) {
  const helper=path.join(binDir,'install-schedule.sh'), runner=path.join(binDir,'run-daily-intel.sh');
  const stateFile=path.join(dataDir,'logs','intel-control.json');
  const preferenceFile=path.join(dataDir,'intel-schedule-preference.json');
  let child=null, changingSchedule=false;
  function readPreference(){try{const value=JSON.parse(fs.readFileSync(preferenceFile,'utf8'));if(!value||value.schema!=='job-quest-intel-schedule/1'||!['off','daily','weekdays'].includes(value.frequency))throw Error('invalid preference');return value;}catch(e){if(e.code==='ENOENT')return null;throw failure('The saved Intel schedule preference could not be read. Repair it before changing the schedule.',503);}}
  function writePreference(value,cron){const preference={schema:'job-quest-intel-schedule/1',frequency:value.frequency,time:cron?value.time:null,cron,updatedAt:now().toISOString(),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone};const temp=`${preferenceFile}.${crypto.randomUUID()}.tmp`;try{fs.writeFileSync(temp,JSON.stringify(preference,null,2),{mode:0o600,flag:'wx'});fs.renameSync(temp,preferenceFile);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}
  // Written by run-daily-intel.sh for every run, including scheduled ones the dashboard did not start.
  function readLastRun() {try {const value=JSON.parse(fs.readFileSync(path.join(dataDir,'logs','daily-intel-last-run.json'),'utf8'));return value&&typeof value.status==='string'?value:null;} catch(e) {if(e.code==='ENOENT') return null; return {status:'unknown',reason:'The last run record could not be read.'};}}
  function latestIntelDate() {try {return fs.readdirSync(path.join(dataDir,'intel')).map(name=>/^(\d{4}-\d{2}-\d{2})\.json$/.exec(name)?.[1]).filter(Boolean).sort().pop()||null;} catch {return null;}}
  function readRun() {try {return JSON.parse(fs.readFileSync(stateFile,'utf8'));} catch(e) {if(e.code==='ENOENT') return null; return {status:'unknown',error:'Run history could not be read. Existing data was preserved.'};}}
  function writeRun(run) {fs.mkdirSync(path.dirname(stateFile),{recursive:true}); const temp=`${stateFile}.${process.pid}.tmp`;fs.writeFileSync(temp,JSON.stringify(run,null,2),{mode:0o600});fs.renameSync(temp,stateFile);}
  function setup() {try{const value=JSON.parse(fs.readFileSync(path.join(dataDir,'local-setup.json'),'utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid setup');return value;}catch(e){if(e.code==='ENOENT')return {};throw failure('Local setup could not be read. Repair it before running Intel.',503);}}
  function runtime() {const r=getRuntime();return {displayName:r.runtimeDisplayName,ready:r.runtimeValidation?.status==='ready',error:r.runtimeValidation?.lastFailureReason || null};}
  function requireMatchingData() {const r=getRuntime();if(r.dataDir){const configured=r.dataDir.replace(/^~(?=\/|$)/,require('os').homedir());if(path.resolve(configured)!==path.resolve(dataDir))throw failure('This dashboard uses a different data folder from the native Intel runner. Update the Job Quest runtime data directory before running or scheduling Intel.',503);}}
  async function status() {
    let schedule={installed:false,cron:null,error:null};
    try {const result=await exec('/bin/bash',[helper,'--current-cron'],{timeout:10000,maxBuffer:16384});const cron=result.stdout.trim();if(cron) schedule={installed:true,cron,error:null};}catch(e){if(e.code!==1)schedule.error='Could not inspect the native Intel schedule.';}
    const date=getLocalDateStamp(now());
    const outputs=Object.fromEntries(['intel','quizzes','tasks'].map(kind=>[kind,fs.existsSync(path.join(dataDir,kind,`${date}.json`))]));
    const lockDir=path.join(dataDir,'logs','.daily-intel.lock');
    const lock=lockState(lockDir);let run=readRun();if(run?.status==='running'&&!child&&lock==='absent')run={...run,status:'interrupted',error:'The dashboard restarted before this requested run could be confirmed. Check the run log.'};return {runtime:runtime(),schedule,schedulePreference:readPreference(),outreachOwner:setup().schedule==='external'?'external':'native',run,running:!!child||['running','unknown'].includes(lock),lock,outputs,lastRun:readLastRun(),latestIntelDate:latestIntelDate(),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone};
  }
  async function configure(value) {
    const cron=scheduleCron(value);
    if(changingSchedule)throw failure('Another schedule change is in progress.',409);
    setup();readPreference();requireMatchingData();if(cron&&!runtime().ready)throw failure('Configure the agent runtime before scheduling Intel.',503);
    changingSchedule=true;
    try {await exec('/bin/bash',[helper,cron||'--uninstall'],{timeout:30000,maxBuffer:32768});try{writePreference(value,cron);}catch{throw failure('The native schedule changed, but its saved preference could not be written. Check the data-folder permissions before restarting Job Quest.',503);}return await status();}
    catch(e){if(e.status)throw e;throw failure('The Intel schedule could not be changed. Check the native scheduling helper on this Mac.',503);}
    finally {changingSchedule=false;}
  }
  function run() {
    setup(); requireMatchingData();if(!runtime().ready)throw failure('Configure the agent runtime before running Intel.',503);
    if(child||['running','unknown'].includes(lockState(path.join(dataDir,'logs','.daily-intel.lock'))))throw failure('Intel is already running, or its last run left a lock. Check the run log before retrying.',409);
    if(!fs.existsSync(path.join(dataDir,'profile.json')))throw failure('Complete your job-search profile before running Intel.',409);
    const run={status:'running',startedAt:now().toISOString(),finishedAt:null,error:null};writeRun(run);
    const log=fs.openSync(path.join(dataDir,'logs','intel-control.log'),'a',0o600);
    let active;
    try {active=launch('/bin/bash',[runner],{stdio:['ignore',log,log],env:{...process.env,JOB_QUEST_INTEL_TRIGGER:'dashboard'}});child=active;}
    catch(e){fs.closeSync(log);writeRun({...run,status:'failed',finishedAt:now().toISOString(),error:'Intel could not start. Check the run log.'});throw failure('Intel could not start. Check the run log.',503);}
    fs.closeSync(log);
    let finished=false;
    function finish(code,error) {if(finished)return;finished=true;child=null;try{writeRun({...run,status:error||code!==0?'failed':'completed',finishedAt:now().toISOString(),exitCode:code,error:error||code!==0?'Intel did not complete. Check the run log for the runtime or collection error.':null});}catch{/* Preserve the existing log if history cannot be saved. */}}
    active.once('error',()=>finish(null,true));active.once('close',code=>finish(code,false));
    return {accepted:true,run};
  }
  return {status,configure,run};
}
function registerIntelControls(app,options) {
  const control=createIntelControls(options);
  const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){res.status(e.status||500).json({error:e.status?e.message:'Intel controls are unavailable. Existing data was preserved.'});}};
  app.get('/api/intel-control',wrap(async(req,res)=>res.json(await control.status())));
  app.post('/api/intel-control/run',wrap(async(req,res)=>res.status(202).json(control.run())));
  app.put('/api/intel-control/schedule',wrap(async(req,res)=>res.json(await control.configure(req.body))));
  return control;
}
module.exports={createIntelControls,registerIntelControls,scheduleCron};
