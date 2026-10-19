const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {syncNativeIntel, projectBrief} = require('./intel');
const {normalizeConversationReview} = require('./conversation-review');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 400) => Object.assign(Error(message), {status});
const json = value => JSON.stringify(value, null, 2) + '\n';
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
function getPaths(dataDir, {briefPath, queuePath} = {}) {
  const directory = path.join(dataDir, 'outreach');
  return {directory, briefPath:briefPath || path.join(directory,'brief.json'), queuePath:queuePath || path.join(directory,'queue.json'), native:!briefPath && !queuePath};
}
function read(file, kind) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file,'utf8')); }
  catch { throw fail(`Native outreach ${kind} is unavailable. Existing data was preserved.`,503); }
  const groups = kind === 'brief' ? ['sources','opportunities'] : ['items','holds'];
  if (!object(value) || groups.some(key => !Array.isArray(value[key]) || value[key].some(item => !object(item)))) throw fail(`Native outreach ${kind} is malformed. Existing data was preserved.`,503);
  const records = kind === 'brief' ? value.opportunities : [...value.items,...value.holds];
  if (records.some(item => typeof item.id !== 'string' || !item.id) || new Set(records.map(item=>item.id)).size !== records.length) throw fail(`Native outreach ${kind} has ambiguous record IDs. Existing data was preserved.`,503);
  return value;
}
function write(file, bytes, exclusive = false) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp,bytes,{mode:0o600,flag:'wx'});
    if (exclusive) fs.linkSync(temp,file); else fs.renameSync(temp,file);
  } finally {if(fs.existsSync(temp)) fs.unlinkSync(temp);}
}
const busy = () => fail('Outreach is being updated or its lock owner cannot be verified. Retry after the current writer finishes.',409);
const sameInode = (a,b) => a.dev === b.dev && a.ino === b.ino;
function ownerRecord(lock) {
  const inode=fs.statSync(lock);
  const bytes=fs.readFileSync(path.join(lock,'owner.json'));
  const owner=JSON.parse(bytes);
  if (!object(owner) || owner.schema!=='job-quest-outreach-lock/1' || !Number.isInteger(owner.pid) || owner.pid<=0 || typeof owner.nonce!=='string' || !/^[a-f0-9-]{36}$/i.test(owner.nonce)) throw busy();
  if (!sameInode(inode,fs.statSync(lock))) throw busy();
  return {owner,bytes,inode};
}
function ownerIsDead(pid) {
  try {process.kill(pid,0);return false;}
  catch(error) {return error.code==='ESRCH';}
}
function reclaimDeadLock(lock) {
  // Serialize reclaimers separately from the writer directory. A writer can
  // acquire the freed path after rename without having its new lock removed.
  const recovery=`${lock}.recovery`;
  try {fs.mkdirSync(recovery,{mode:0o700});} catch {throw busy();}
  try {
    let recorded;
    try {recorded=ownerRecord(lock);} catch {throw busy();}
    if (!ownerIsDead(recorded.owner.pid)) throw busy();
    const current=ownerRecord(lock);
    if (!sameInode(current.inode,recorded.inode) || !current.bytes.equals(recorded.bytes) || !ownerIsDead(current.owner.pid)) throw busy();
    const moved=`${lock}.stale-${crypto.randomUUID()}`;
    fs.renameSync(lock,moved);
    fs.rmSync(moved,{recursive:true});
  } finally {fs.rmdirSync(recovery);}
}
function withStoreLock(dataDir, fn) {
  const dir=getPaths(dataDir).directory;
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const lock=path.join(dir,'.write.lock');
  try {fs.mkdirSync(lock,{mode:0o700});}
  catch(error) {
    if(error.code!=='EEXIST') throw error;
    reclaimDeadLock(lock);
    try {fs.mkdirSync(lock,{mode:0o700});} catch(error) {if(error.code==='EEXIST') throw busy();throw error;}
  }
  const inode=fs.statSync(lock), ownerBytes=Buffer.from(json({schema:'job-quest-outreach-lock/1',pid:process.pid,nonce:crypto.randomUUID()}));
  try {write(path.join(lock,'owner.json'),ownerBytes,true);}
  catch(error) {try {fs.rmdirSync(lock);} catch {} throw error;}
  try {return fn();}
  finally {
    let current;
    try {current=ownerRecord(lock);} catch {}
    // Never unlink metadata or a directory now belonging to a different owner.
    if(current && sameInode(current.inode,inode) && current.bytes.equals(ownerBytes)) {
      fs.unlinkSync(path.join(lock,'owner.json'));
      fs.rmdirSync(lock);
    }
  }
}
function ensureUnlocked(dataDir) {
  const paths = getPaths(dataDir), briefExists = fs.existsSync(paths.briefPath), queueExists = fs.existsSync(paths.queuePath);
  if (!briefExists && !queueExists) {
    try {
      write(paths.briefPath,json({schema:'job-quest-collection/1',generatedAt:null,summary:'',sources:[],opportunities:[]}),true);
      write(paths.queuePath,json({version:1,updatedAt:null,items:[],holds:[]}),true);
    } catch(error) {
      if (fs.existsSync(paths.briefPath) && !fs.existsSync(paths.queuePath)) fs.unlinkSync(paths.briefPath);
      throw error;
    }
  }
  read(paths.briefPath,'brief'); read(paths.queuePath,'queue');
  return paths;
}
function ensureNativeStore(dataDir) {return withStoreLock(dataDir,()=>ensureUnlocked(dataDir));}
function validateCollection(input) {
  if (!object(input) || (input.schema !== undefined && input.schema !== 'job-quest-collection/1') || !Array.isArray(input.sources) || !Array.isArray(input.opportunities)
    || ['queue','items','holds'].some(key=>Object.hasOwn(input,key))) throw fail('A collected brief with sources and opportunities is required; replacement reply queues are not accepted.');
  if (input.generatedAt !== undefined && input.generatedAt !== null && !timestamp(input.generatedAt)) throw fail('Collection generatedAt requires a timestamp with timezone.');
  if (input.summary !== undefined && typeof input.summary !== 'string') throw fail('Collection summary must be text.');
  for (const source of input.sources) {
    if (!object(source) || typeof source.name !== 'string' || !source.name.trim() || typeof source.status !== 'string' || !source.status.trim()
      || (source.checkedAt !== undefined && source.checkedAt !== null && source.checkedAt !== '' && !timestamp(source.checkedAt))) throw fail('Collection source coverage is invalid.');
  }
  const ids = new Set();
  const urls = ['sourceUrl','emailSourceUrl','linkedinSourceUrl','invitationSourceUrl','relatedRoleUrl','schedulingUrl'];
  for (const item of input.opportunities) {
    if (!object(item) || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(item.id) || ids.has(item.id) || !['recruiter','job'].includes(item.kind)) throw fail('Collection opportunities require unique stable IDs and a known kind.');
    ids.add(item.id);
    if (item.checkedAt !== undefined && item.checkedAt !== null && item.checkedAt !== '' && !timestamp(item.checkedAt)) throw fail('Opportunity checkedAt requires a timestamp with timezone.');
    for (const key of ['title','company','location','summary','fit','concern','nextAction','availability','draftReply','preparedDraft']) if (item[key] !== undefined && typeof item[key] !== 'string') throw fail(`Opportunity ${key} must be text.`);
    if ((item.preparedDraft?.length || 0)>4000 || (item.draftReply?.length || 0)>4000) throw fail('Prepared reply is too long.');
    const validUrl = value => {try {const u=new URL(value);return typeof value === 'string' && u.protocol==='https:' && !u.username && !u.password;}catch{return false;}};
    if (urls.some(key=>item[key] !== undefined && item[key] !== null && item[key] !== '' && !validUrl(item[key]))
      || (item.sourceLinks !== undefined && (!Array.isArray(item.sourceLinks) || item.sourceLinks.some(url=>!validUrl(url))))) throw fail('Opportunity source links require HTTPS URLs without credentials.');
  }
  // Normalize a JSON snapshot before entering the writer lock; reject unsupported/cyclic input.
  try {return JSON.parse(JSON.stringify(input));} catch {throw fail('Collection must be valid JSON.');}
}
function fresher(old, incoming) {
  return timestamp(old?.checkedAt) && (!timestamp(incoming?.checkedAt) || Date.parse(old.checkedAt)>Date.parse(incoming.checkedAt));
}
function mergeBrief(previous, input) {
  if (timestamp(previous.generatedAt) && (!timestamp(input.generatedAt) || Date.parse(input.generatedAt)<Date.parse(previous.generatedAt))) throw fail('Collection is older than the saved brief. Re-read current evidence before collecting again.',409);
  const items = new Map(previous.opportunities.map(item=>[item.id,item]));
  for (const item of input.opportunities) {
    const old=items.get(item.id);
    if (old?.kind && old.kind!==item.kind) throw fail('A stable opportunity ID cannot change kind.',409);
    if (old && fresher(old,item)) continue;
    items.set(item.id,{...old,...item,sourceLinks:[...new Set([...(old?.sourceLinks || []),...(item.sourceLinks || []),...['sourceUrl','emailSourceUrl','linkedinSourceUrl','invitationSourceUrl'].flatMap(key=>[old?.[key],item[key]].filter(Boolean))])]});
  }
  const key = source=>`${source.accountId || ''}|${source.name.trim().toLowerCase()}`;
  const sources=new Map(previous.sources.map(source=>[key(source),source]));
  for(const source of input.sources) {
    const old=sources.get(key(source));
    // A blocked attempt may be newer without having a new reviewed window. Keep the actual last check.
    if(old && timestamp(old.checkedAt) && timestamp(source.checkedAt) && Date.parse(old.checkedAt)>Date.parse(source.checkedAt)) continue;
    sources.set(key(source),{...old,...source,...(old?.checkedAt && !timestamp(source.checkedAt) ? {checkedAt:old.checkedAt} : {})});
  }
  return {...previous,...input,generatedAt:input.generatedAt || previous.generatedAt || null,sources:[...sources.values()],opportunities:[...items.values()]};
}
function seedQueue(queue, brief) {
  const ids=new Set([...queue.items,...queue.holds].map(item=>item.id));
  const fields=['id','title','company','role','location','channel','sourceAccount','accountId','account','sourceUrl','emailSourceUrl','linkedinSourceUrl','invitationSourceUrl','relatedRoleUrl','schedulingUrl','sourceLinks','relatedThreadIds','recruiter','sender','senderEmail','recruiterEmail','recipientEmail','lastInboundAt','lastInboundDate','checkedAt','requestedReplyChannel','recruiterRequestedChannel','ongoingSubstantiveChannel','needsDocuments','needsResume','replyRequiresDocuments','responseType'];
  const added=brief.opportunities.filter(item=>item.kind==='recruiter' && !ids.has(item.id)).map(item=>({...Object.fromEntries(fields.filter(key=>Object.hasOwn(item,key)).map(key=>[key,item[key]])),draftReply:item.preparedDraft ?? item.draftReply ?? '',status:'ready_for_review',nextReminderAt:null,reminderCount:0}));
  return added.length ? {...queue,items:[...queue.items,...added],updatedAt:new Date().toISOString()} : queue;
}
function ingestCollection({dataDir,collection}) {
  const input=validateCollection(collection);
  return withStoreLock(dataDir,()=>{
    const paths=ensureUnlocked(dataDir), previous=read(paths.briefPath,'brief'), queue=read(paths.queuePath,'queue');
    const brief=mergeBrief(previous,input);
    const queueRecords=new Map([...queue.items,...queue.holds].map(item=>[item.id,item]));
    // Review evidence belongs to the brief. Never rewrite dashboard-owned drafts,
    // sent reports, status or reminder history during account collection.
    brief.opportunities=brief.opportunities.map(item=>Object.hasOwn(item,'conversationReview')
      ? {...item,conversationReview:normalizeConversationReview(item.conversationReview,item,queueRecords.get(item.id))} : item);
    const nextQueue=seedQueue(queue,brief);
    syncNativeIntel(dataDir,brief,{dryRun:true});
    const intelFiles=projectBrief(brief).reports.map(report=>path.join(dataDir,'intel',`${report.date}-career-review-migration.json`));
    const files=[paths.briefPath,paths.queuePath,...intelFiles];
    const before=files.map(file=>fs.existsSync(file)?fs.readFileSync(file):null);
    const next=[json(brief),nextQueue===queue ? before[1].toString() : json(nextQueue)];
    const changed=next.some((bytes,i)=>!before[i] || bytes!==before[i].toString());
    let backupDir=null;
    if(changed || intelFiles.length) {
      backupDir=path.join(paths.directory,'backups',`${new Date().toISOString().replace(/[:.]/g,'-')}-${crypto.randomUUID()}`);
      fs.mkdirSync(backupDir,{recursive:true,mode:0o700});
      before.forEach((bytes,i)=>{if(bytes!==null) fs.writeFileSync(path.join(backupDir,`${i}-${path.basename(files[i])}`),bytes,{mode:0o600,flag:'wx'});});
      fs.writeFileSync(path.join(backupDir,'manifest.json'),json({schema:'job-quest-outreach-backup/1',files:files.map((file,i)=>({file,existed:before[i]!==null,sha256:before[i]===null?null:crypto.createHash('sha256').update(before[i]).digest('hex')}))}),{mode:0o600,flag:'wx'});
    }
    try {
      next.forEach((bytes,i)=>{if(before[i]?.toString()!==bytes) write(files[i],bytes);});
      const intel=syncNativeIntel(dataDir,brief);
      return {success:true,briefPath:paths.briefPath,queuePath:paths.queuePath,opportunities:brief.opportunities.length,queuedRecruiters:nextQueue.items.length+nextQueue.holds.length,backupDir,intel};
    } catch(error) {
      files.forEach((file,i)=>{try {if(before[i]===null) {if(fs.existsSync(file)) fs.unlinkSync(file);} else write(file,before[i]);}catch(restoreError){error.restoreError=restoreError;}});
      throw error;
    }
  });
}
module.exports={getPaths,ensureNativeStore,ingestCollection,withStoreLock};
