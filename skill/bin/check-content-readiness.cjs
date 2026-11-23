#!/usr/bin/env node
const path=require('path'), fs=require('fs');
const roots=[path.resolve(__dirname,'../..'),path.resolve(__dirname,'../app')];
const root=roots.find(dir=>fs.existsSync(path.join(dir,'app/lib/learning/readiness.js')));
if(!root){console.error('Content readiness helper is unavailable; continue with existing saved content.');process.exit(1);}
const {assessContentReadiness}=require(path.join(root,'app/lib/learning/readiness.js'));
const {ensureRuntime,expandHome}=require(path.join(root,'lib/runtime.js'));
try {
  const runtime=ensureRuntime({write:false});
  const dataDir=expandHome(process.env.DATA_DIR || process.env.JOB_QUEST_DATA_DIR || runtime.dataDir);
  console.log(JSON.stringify(assessContentReadiness(dataDir),null,2));
}
catch(error){console.error('Content readiness could not be checked; existing saved data was preserved.');process.exitCode=1;}
