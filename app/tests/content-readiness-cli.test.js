const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
function fixture(t,installed=false){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'jq-readiness-cli-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const product=path.join(home,'.job-quest'),custom=path.join(home,'custom-data'),config=path.join(product,'config/runtime.json');
 fs.mkdirSync(path.dirname(config),{recursive:true});fs.writeFileSync(config,JSON.stringify({activeRuntime:'codex',dataDir:'~/custom-data'})+'\n');
 fs.mkdirSync(path.join(custom,'tasks'),{recursive:true});fs.writeFileSync(path.join(custom,'tasks','2026-01-01.json'),JSON.stringify({tasks:[{category:'behavioral',text:'Describe resolving a conflict'}]}));
 fs.mkdirSync(path.join(product,'data'),{recursive:true});fs.writeFileSync(path.join(product,'data','protected.json'),'original old data');
 let helper=path.join(root,'skill/bin/check-content-readiness.cjs');
 if(installed){const repo=path.join(product,'app');for(const file of ['lib/runtime.js','app/lib/local-date.js','app/lib/learning/readiness.js','app/lib/learning/catalog.js']){const dest=path.join(repo,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(root,file),dest);}helper=path.join(product,'bin/check-content-readiness.cjs');fs.mkdirSync(path.dirname(helper),{recursive:true});fs.copyFileSync(path.join(root,'skill/bin/check-content-readiness.cjs'),helper);}
 const configBytes=fs.readFileSync(config),protectedBytes=fs.readFileSync(path.join(product,'data/protected.json'));
 return {home,product,custom,config,helper,configBytes,protectedBytes};
}
function run(f,extra={}){const result=spawnSync(process.execPath,[f.helper],{env:{HOME:f.home,PATH:'/usr/bin:/bin',...extra},encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);assert.deepEqual(fs.readFileSync(f.config),f.configBytes);assert.deepEqual(fs.readFileSync(path.join(f.product,'data/protected.json')),f.protectedBytes);return JSON.parse(result.stdout);}
for(const installed of [false,true])test(`${installed?'installed':'source'} readiness helper honors custom runtime dataDir read-only`,t=>{const f=fixture(t,installed),r=run(f);assert.equal(r.behavioral.total,1);assert.deepEqual(fs.readdirSync(path.join(f.product,'data')),['protected.json']);});
test('explicit DATA_DIR wins over JOB_QUEST_DATA_DIR and expands home paths',t=>{const f=fixture(t),override=path.join(f.home,'explicit-data');fs.mkdirSync(override);let r=run(f,{DATA_DIR:'~/explicit-data',JOB_QUEST_DATA_DIR:f.custom});assert.equal(r.behavioral.total,0);r=run(f,{JOB_QUEST_DATA_DIR:'~/custom-data'});assert.equal(r.behavioral.total,1);assert.deepEqual(fs.readdirSync(override),[]);});
