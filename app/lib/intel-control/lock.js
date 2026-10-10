const fs=require('fs');const path=require('path');const crypto=require('crypto');
const same=(a,b)=>a.ino===b.ino&&a.dev===b.dev;
const busy=()=>Object.assign(new Error('Intel is running or its lock owner cannot be verified.'),{code:'EBUSY'});
function record(dir){const inode=fs.statSync(dir);const bytes=fs.readFileSync(path.join(dir,'owner.json'));const owner=JSON.parse(bytes);if(owner.schema!=='job-quest-intel-lock/1'||!Number.isInteger(owner.pid)||owner.pid<=0||!/^[-a-f0-9]{36}$/i.test(owner.nonce)||!same(inode,fs.statSync(dir)))throw busy();return {inode,bytes,owner};}
function dead(pid){try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}}
function state(dir){try{return dead(record(dir).owner.pid)?'stale':'running';}catch(e){return e.code==='ENOENT'&&!fs.existsSync(dir)?'absent':'unknown';}}
function acquire(dir,pid){if(!Number.isInteger(pid)||pid<=0)throw busy();fs.mkdirSync(path.dirname(dir),{recursive:true,mode:0o700});try{fs.mkdirSync(dir,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;const recovery=`${dir}.recovery`;try{fs.mkdirSync(recovery,{mode:0o700});}catch{throw busy();}try{const before=record(dir);if(!dead(before.owner.pid))throw busy();const after=record(dir);if(!same(before.inode,after.inode)||!before.bytes.equals(after.bytes)||!dead(after.owner.pid))throw busy();const moved=`${dir}.stale-${crypto.randomUUID()}`;fs.renameSync(dir,moved);fs.rmSync(moved,{recursive:true});}finally{fs.rmdirSync(recovery);}try{fs.mkdirSync(dir,{mode:0o700});}catch{throw busy();}}
  const nonce=crypto.randomUUID();fs.writeFileSync(path.join(dir,'owner.json'),JSON.stringify({schema:'job-quest-intel-lock/1',pid,nonce}),{flag:'wx',mode:0o600});return nonce;
}
function release(dir,pid,nonce){let before;try{before=record(dir);}catch{return;}if(before.owner.pid!==pid||before.owner.nonce!==nonce)return;const after=record(dir);if(!same(before.inode,after.inode)||!before.bytes.equals(after.bytes))return;fs.unlinkSync(path.join(dir,'owner.json'));fs.rmdirSync(dir);}
if(require.main===module){try{const [action,dir,pid,nonce]=process.argv.slice(2);if(action==='acquire')console.log(acquire(dir,Number(pid)));else if(action==='release')release(dir,Number(pid),nonce);else throw busy();}catch(e){console.error(e.message);process.exitCode=73;}}
module.exports={acquire,release,state};
