const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const SCHEMA='job-quest-intel-preferences/1';
const keys=['jobs','outreach','practice'];
function validate(value) {
  if(!value||Array.isArray(value)||value.schema!==SCHEMA||Object.keys(value).some(key=>!['schema','scopes'].includes(key))||!value.scopes||Array.isArray(value.scopes)||Object.keys(value.scopes).length!==keys.length||keys.some(key=>typeof value.scopes[key]!=='boolean'))throw Object.assign(Error('Intel preferences are invalid. Expected jobs, outreach and practice switches; repair or save the configuration before running Intel.'),{status:400});
  return {schema:SCHEMA,scopes:Object.fromEntries(keys.map(key=>[key,value.scopes[key]]))};
}
function read(dataDir) {
  try{return validate(JSON.parse(fs.readFileSync(path.join(dataDir,'intel-preferences.json'),'utf8')));}catch(error){if(error.code==='ENOENT')return {schema:SCHEMA,scopes:{jobs:true,outreach:true,practice:true}};throw Object.assign(Error('Saved Intel preferences could not be read or are invalid. Save a valid Intel configuration before running.'),{status:503});}
}
function write(dataDir,value) {
  const config=validate(value),file=path.join(dataDir,'intel-preferences.json'),temp=`${file}.${crypto.randomUUID()}.tmp`;
  try{fs.writeFileSync(temp,JSON.stringify(config,null,2),{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  return config;
}
module.exports={read,write,validate};
if(require.main===module){try{const {scopes}=read(process.argv[2]);process.stdout.write(keys.map(key=>scopes[key]?'1':'0').join(' '));}catch(error){console.error(error.message);process.exitCode=1;}}
