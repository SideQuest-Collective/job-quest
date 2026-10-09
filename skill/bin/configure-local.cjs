#!/usr/bin/env node
// Explicit local configuration; does not install a schedule or expose a service.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const args=process.argv.slice(2);const data=path.resolve(process.env.DATA_DIR || path.join(os.homedir(),'.job-quest/data'));
const file=path.join(data,'local-setup.json');
try {
 let config={};try{config=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('Existing setup is unreadable; preserved without changes.');}
 if(!args.length || args.includes('--help')){console.log('Usage: configure-local.cjs [--career-brief /absolute/brief.json] [--reply-queue /absolute/queue.json] [--interview-home /absolute/interview-home] [--external-schedule] [--private-origin https://device.tailnet.ts.net --tailscale-user your-login] [--local-only]\nAll options are optional. Local-only is the default. Restart Job Quest after changing setup.');process.exit(0);}
 for(let i=0;i<args.length;i++){
  const flag=args[i];
  if(flag==='--local-only'){delete config.privateOrigin;delete config.tailscaleUser;continue;}
  if(flag==='--external-schedule'){config.schedule='external';continue;}
  if(!['--career-brief','--reply-queue','--interview-home','--private-origin','--tailscale-user'].includes(flag))throw Error('Unknown option: '+flag);
  const value=args[++i];if(!value || value.startsWith('--'))throw Error('Missing value for '+flag);
  if(flag==='--career-brief'||flag==='--reply-queue'||flag==='--interview-home'){
   if(!path.isAbsolute(value))throw Error('Use an absolute local path.');
   if(flag==='--interview-home'){
    if(!fs.statSync(value).isDirectory())throw Error('Interview home must be a directory.');
    config.interviewHome=value;
   }else{
    const content=JSON.parse(fs.readFileSync(value,'utf8'));
    if(flag==='--career-brief'&&(!Array.isArray(content.opportunities)||!Array.isArray(content.sources)))throw Error('Career brief must contain opportunities and sources.');
    if(flag==='--reply-queue'&&(!Array.isArray(content.items)||!Array.isArray(content.holds)))throw Error('Reply queue must contain items and holds.');
    config[flag==='--career-brief'?'careerBrief':'replyQueue']=value;
   }
  } else if(flag==='--private-origin'){
   const u=new URL(value);if(u.protocol!=='https:'||u.origin!==value||!u.hostname.endsWith('.ts.net'))throw Error('Use the exact HTTPS Tailscale Serve origin.');config.privateOrigin=value;
  }else{if(!value.trim()||/[\r\n]/.test(value))throw Error('Invalid Tailscale identity');config.tailscaleUser=value.trim();}
 }
 if(Boolean(config.privateOrigin)!==Boolean(config.tailscaleUser))throw Error('Private access requires both origin and exact Tailscale login identity.');
 fs.mkdirSync(data,{recursive:true,mode:0o700});const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temp,file);
 console.log('Local setup saved. '+(config.privateOrigin?'Private origin configured; network access is not enabled by this command.':'Local-only access. No Tailscale required.')+' Restart Job Quest to apply.');
}catch(e){console.error(e.message);process.exitCode=1;}
