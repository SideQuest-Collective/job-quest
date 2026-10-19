const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../public/setup.jsx'),'utf8');
const component=source.slice(source.indexOf('function TrainerPreferences'),source.indexOf('function RuntimeChecks'));
const handler=component.match(/onClick=\{(async\(\)=>\{setBusy\(true\);[\s\S]*?)\}\}>\{config\.enabled/)[1];
for(const fails of [false,true])test(`Trainer reminder toggle unlocks after ${fails?'a failed':'a successful'} save`,async()=>{
 const busy=[],errors=[],messages=[],configs=[],requests=[];
 const ctx={config:{enabled:true},setBusy:v=>busy.push(v),setError:v=>errors.push(v),setMessage:v=>messages.push(v),setConfig:v=>configs.push(v),request:async(...args)=>{requests.push(args);if(fails)throw Error('Offline');return {config:{enabled:false}};}};
 vm.createContext(ctx);await vm.runInContext('('+handler+'})()',ctx);
 assert.deepEqual(busy,[true,false]);assert.equal(requests[0][0],'/api/trainer/config');assert.equal(requests[0][2].enabled,false);
 if(fails){assert.deepEqual(errors,['Offline']);assert.deepEqual(configs,[]);}else{assert.equal(configs[0].enabled,false);assert.deepEqual(messages,['Reminders paused.']);}
});
