const fs = require('fs');
const path = require('path');
const { getLocalDateStamp } = require('../local-date');
const catalog = require('./catalog');
const DEFAULTS = Object.freeze({ behavioralQuestions: 5, quizQuestions: 5, quizTopics: 3, quizMaxAgeDays: 7, audioResources: 2, videoResources: 2, mediaPublishers: 2, mediaGoals: 3, mediaMaxAgeDays: 30 });
const normalized = value => typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
function read(file, fallback, warnings) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') warnings.push(`${path.basename(file)} could not be read; saved data was preserved.`); return fallback; }
}
function validateThresholds(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(Error('Readiness thresholds must be an object.'), {status:400});
  for (const [key, value] of Object.entries(input)) if (!(key in DEFAULTS) || !Number.isInteger(value) || value < 1 || value > (key.endsWith('Days') ? 365 : 100)) throw Object.assign(Error(`Invalid readiness threshold: ${key}. Use whole numbers from 1 to ${key.endsWith('Days') ? 365 : 100}.`), {status:400});
  return {...DEFAULTS, ...input};
}
function readThresholds(dataDir, warnings) {
  const saved = read(path.join(dataDir, 'learning', 'readiness.json'), {}, warnings);
  try { return validateThresholds(saved); } catch { warnings.push('Readiness settings are invalid; defaults are being used. Saved settings were preserved.'); return {...DEFAULTS}; }
}
function writeThresholds(dataDir, input) {
  const thresholds = validateThresholds(input);
  const dir = path.join(dataDir, 'learning'); fs.mkdirSync(dir, {recursive:true, mode:0o700});
  const file = path.join(dir, 'readiness.json'), tmp = `${file}.${process.pid}.${require('crypto').randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(thresholds, null, 2)+'\n', {mode:0o600, flag:'wx'}); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return thresholds;
}
function dateAge(date, today) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return Infinity;
  const timestamp = Date.parse(date+'T12:00:00Z');
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0,10) !== date) return Infinity;
  return (Date.parse(today+'T12:00:00Z')-timestamp)/86400000;
}
function datedFiles(dataDir, kind, warnings) {
  const dir = path.join(dataDir, kind);
  try { return fs.readdirSync(dir).filter(file => /^\d{4}-\d{2}-\d{2}\.json$/.test(file)).sort().map(file => ({date:file.slice(0,10), data:read(path.join(dir,file), null, warnings)})); }
  catch (error) { if (error.code !== 'ENOENT') warnings.push(`${kind} could not be read; saved data was preserved.`); return []; }
}
function questionIdentity(text) {let h=2166136261;for(const c of text.trim().toLowerCase()){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return `bq_text_${(h>>>0).toString(16)}`;}
function assessContentReadiness(dataDir, {now=new Date(), media=catalog}={}) {
  const warnings=[], thresholds=readThresholds(dataDir,warnings), date=getLocalDateStamp(now);
  const answers=read(path.join(dataDir,'behavioral','answers.json'),{},warnings), prompts=new Map();
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) warnings.push('Behavioral answers are unreadable; readiness cannot verify available unanswered prompts.');
  for (const row of datedFiles(dataDir,'tasks',warnings)) {
    if (!row.data || !Array.isArray(row.data.tasks)) {warnings.push(`Tasks for ${row.date} are unreadable.`);continue;}
    if (!Number.isFinite(dateAge(row.date,date)) || dateAge(row.date,date)<0) continue;
    for(const task of row.data.tasks) if(task?.category==='behavioral' && normalized(task.text)) prompts.set(normalized(task.text),task.text);
  }
  const unanswered=[...prompts.values()].filter(text => !normalized(answers?.[questionIdentity(text)]?.answer));
  const questions=new Map(), topics=new Set(); let latestQuizDate=null;
  for(const row of datedFiles(dataDir,'quizzes',warnings)) {
    const age=dateAge(row.date,date);if(age<0 || age>thresholds.quizMaxAgeDays)continue;
    if(!Array.isArray(row.data?.questions)){warnings.push(`Quiz for ${row.date} is unreadable.`);continue;}
    for(const q of row.data.questions) if(normalized(q?.question) && Array.isArray(q.options) && q.options.length===4 && q.options.every(option=>normalized(option)) && Number.isInteger(q.correctIndex) && q.correctIndex>=0 && q.correctIndex<4 && normalized(q.explanation)) {
      questions.set(normalized(q.question), q);
      const topic=normalized(q.type || q.category).replace(/[-_]/g,' ');if(topic)topics.add(topic);
      latestQuizDate=row.date;
    }
  }
  const eligible=(Array.isArray(media)?media:[]).filter(item=>['audio','video'].includes(item?.kind)&& normalized(item.title)&&normalized(item.goal)&&normalized(item.publisher)&&typeof item.url==='string'&&/^https:\/\//.test(item.url));
  const distinct=[...new Map(eligible.map(item=>[item.url,item])).values()];
  const fresh=distinct.filter(item=>{const age=dateAge(item.checkedAt,date);return age>=0&&age<=thresholds.mediaMaxAgeDays;});
  const counts={audio:fresh.filter(item=>item.kind==='audio').length, video:fresh.filter(item=>item.kind==='video').length, publishers:new Set(fresh.map(item=>normalized(item.publisherId || item.publisher.replace(/\s*[·-]\s*episode\s+\d+.*$/i,'')))).size, goals:new Set(fresh.map(item=>normalized(item.topic || item.goal))).size};
  const behavioral={ready:unanswered.length>=thresholds.behavioralQuestions,total:prompts.size,available:unanswered.length,minimum:thresholds.behavioralQuestions,href:'/#behavioral'};
  const quiz={ready:questions.size>=thresholds.quizQuestions&&topics.size>=thresholds.quizTopics,questions:questions.size,topics:topics.size,minimumQuestions:thresholds.quizQuestions,minimumTopics:thresholds.quizTopics,latestDate:latestQuizDate,maxAgeDays:thresholds.quizMaxAgeDays,href:'/#quiz'};
  const mediaStatus={ready:counts.audio>=thresholds.audioResources&&counts.video>=thresholds.videoResources&&counts.publishers>=thresholds.mediaPublishers&&counts.goals>=thresholds.mediaGoals,...counts,total:distinct.length,stale:distinct.length-fresh.length,minAudio:thresholds.audioResources,minVideo:thresholds.videoResources,minPublishers:thresholds.mediaPublishers,minGoals:thresholds.mediaGoals,maxAgeDays:thresholds.mediaMaxAgeDays,href:'/#learn',verification:'Catalog check dates only; this check does not open or reverify media links.'};
  const gaps=[];
  if(!behavioral.ready)gaps.push({kind:'behavioral',message:`${unanswered.length}/${thresholds.behavioralQuestions} distinct unanswered behavioral prompts available.`,action:'Ask Job Quest to add behavioral prompts through its existing prep-plan flow; keep all saved answers and other tasks.',href:'/#intel'});
  if(!quiz.ready)gaps.push({kind:'quiz',message:`${questions.size}/${thresholds.quizQuestions} recent quiz questions across ${topics.size}/${thresholds.quizTopics} topics.`,action:'Run Intel for fresh quizzes and prep. Existing dated files are preserved.',href:'/#intel'});
  if(!mediaStatus.ready)gaps.push({kind:'media',message:`${counts.audio}/${thresholds.audioResources} audio and ${counts.video}/${thresholds.videoResources} video resources; ${counts.publishers}/${thresholds.mediaPublishers} publishers and ${counts.goals}/${thresholds.mediaGoals} learning goals.`,action:'Ask Job Quest to add verified public audio/video references across different topics. Intel does not currently curate this catalog.',href:'/#learn'});
  return {date,ready:gaps.length===0&&warnings.length===0,status:warnings.length?'needs_review':gaps.length?'needs_content':'ready',thresholds,behavioral,quiz,media:mediaStatus,gaps,warnings};
}
module.exports={DEFAULTS,assessContentReadiness,writeThresholds,validateThresholds,questionIdentity};
