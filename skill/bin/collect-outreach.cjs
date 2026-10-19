#!/usr/bin/env node
// Shared local collection/import entrypoint. Never connects to accounts or sends.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const root=fs.existsSync(path.join(__dirname,'../../app/lib/outreach/store.js'))?path.resolve(__dirname,'../..'):path.resolve(__dirname,'../app');
const store=require(path.join(root,'app/lib/outreach/store'));
const {syncNativeIntel}=require(path.join(root,'app/lib/outreach/intel'));
function run(args){
 let dataDir=process.env.DATA_DIR||path.join(os.homedir(),'.job-quest/data'),input,briefPath,queuePath,importLegacy=false,init=false;
 for(let i=0;i<args.length;i++){
  const a=args[i];if(a==='--import-legacy')importLegacy=true;else if(a==='--init')init=true;
  else if(['--input','--data-dir','--brief','--queue'].includes(a)){const v=args[++i];if(!v||v.startsWith('--'))throw Error('Missing value for '+a);if(a==='--input')input=v;if(a==='--data-dir')dataDir=v;if(a==='--brief')briefPath=v;if(a==='--queue')queuePath=v;}
  else throw Error('Usage: collect-outreach.cjs --input collection.json [--data-dir path] | --init | --import-legacy --brief path --queue path');
 }
 dataDir=path.resolve(dataDir);
 if(importLegacy){
  if(!briefPath||!queuePath||input||init)throw Error('Legacy import requires only --brief and --queue.');
  const rawBrief=fs.readFileSync(briefPath),rawQueue=fs.readFileSync(queuePath),brief=JSON.parse(rawBrief),queue=JSON.parse(rawQueue);
  if(!Array.isArray(brief.sources)||!Array.isArray(brief.opportunities)||!Array.isArray(queue.items)||!Array.isArray(queue.holds))throw Error('Invalid legacy brief or queue; no changes.');
  for(const [name,records] of [['opportunities',brief.opportunities],['sources',brief.sources],['queue',[...queue.items,...queue.holds]]]) {
   if(records.some(r=>!r||typeof r!=='object'||Array.isArray(r)))throw Error('Invalid legacy '+name+' records; no changes.');
   if(name!=='sources') {const ids=records.map(r=>r.id);if(ids.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id))||new Set(ids).size!==ids.length)throw Error('Invalid or duplicate legacy '+name+' IDs; no changes.');}
  }
  return store.withStoreLock(dataDir,()=>{
   const p=store.getPaths(dataDir),setupPath=path.join(dataDir,'local-setup.json');
   const configRaw=fs.existsSync(setupPath)?fs.readFileSync(setupPath):null;
   const config=configRaw?JSON.parse(configRaw):{};
   for(const [dest,raw] of [[p.briefPath,rawBrief],[p.queuePath,rawQueue]])if(fs.existsSync(dest)&&!fs.readFileSync(dest).equals(raw))throw Error('Native Outreach already contains different data. Reconcile before importing; preserved.');
   syncNativeIntel(dataDir,brief,{dryRun:true});
   const backup=path.join(dataDir,'migration-backups','native-outreach-'+crypto.randomUUID());fs.mkdirSync(backup,{recursive:true,mode:0o700});
   fs.writeFileSync(path.join(backup,'brief.json'),rawBrief,{mode:0o600});fs.writeFileSync(path.join(backup,'queue.json'),rawQueue,{mode:0o600});if(configRaw)fs.writeFileSync(path.join(backup,'local-setup.json'),configRaw,{mode:0o600});
   fs.mkdirSync(path.dirname(p.briefPath),{recursive:true,mode:0o700});
   for(const [dest,raw] of [[p.briefPath,rawBrief],[p.queuePath,rawQueue]])if(!fs.existsSync(dest))fs.writeFileSync(dest,raw,{mode:0o600,flag:'wx'});
   const intel=syncNativeIntel(dataDir,brief);
   delete config.careerBrief;delete config.replyQueue;
   const tmp=setupPath+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(tmp,setupPath);
   return {mode:'import',backup,briefPath:p.briefPath,queuePath:p.queuePath,intel};
  });
 }
 if(init){if(input)throw Error('Choose --init or --input.');store.ensureNativeStore(dataDir);return {mode:'initialized',...store.getPaths(dataDir)};}
 if(!input)throw Error('--input is required.');
 return store.ingestCollection({dataDir,collection:JSON.parse(fs.readFileSync(input,'utf8'))});
}
if(require.main===module){try{console.log(JSON.stringify(run(process.argv.slice(2)),null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={run};
