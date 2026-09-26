import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {docker,directory,prefix} from './runtime.mjs';
import {authority} from './authority.mjs';
const results=[];
const cli=(...args)=>docker(['exec','--user','www-data',prefix+'-web-a','php','/var/www/html/bin/console',...args]);
const run=(file,args=[])=>execFileSync(process.execPath,[directory+file,...args],{stdio:'pipe'});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
for(const scenario of (process.argv.includes('--unapproved-only')?['unapproved']:['unapproved','deliver','revoke','kill'])){
 run('native-fixture.mjs');run('setup-bridge.mjs',['--rearm',...(scenario==='kill'?['--kill-after-consume']:[])]);
 const native=JSON.parse(readFileSync(directory+'private/native-fixture.json')),config=JSON.parse(readFileSync(directory+'private/bridge-config.json'));
 const status=async()=>{const r=await fetch('http://127.0.0.1:3542/status',{method:'POST',headers:{'x-remold-key':config.bridgeKey},body:'{}'});assert.equal(r.status,200);const v=await r.json();return {...v,intents:v.intents.filter(x=>x.occurrence.lead===native.contact)};};
 for(let n=0;n<20;n++){try{await status();break;}catch(e){if(n===19)throw e;await wait(100);}}
 cli('mautic:campaigns:update','-i',String(native.campaign));cli('mautic:campaigns:trigger','-i',String(native.campaign));
 const queued=await status();assert.equal(queued.intents.length,1);assert.equal(queued.intents[0].state,'sealed');
 if(scenario!=='unapproved')authority('harness:approve',{token:config.fixture.A.sessions.owner,id:queued.intents[0].operation,expires:Date.now()+3600000});
 if(scenario==='revoke')authority('harness:revoke',{token:config.fixture.A.sessions.owner,target:config.fixture.A.actors.child});
 let killed=false;
 const worker=()=>{
  try{return docker(['exec','--user','www-data','-e','MAUTIC_MESSENGER_DSN_EMAIL=doctrine://default?redeliver_timeout=1',prefix+'-web-a','php','/var/www/html/bin/console','messenger:consume','email','--limit=5','--time-limit=3','--no-interaction','-vv']);}
  catch(e){if(e.status===137){killed=true;return 'Worker killed after permit consumption';}throw e;}
 };
 writeFileSync(directory+'private/'+scenario+'-worker.log',worker(),{mode:0o600});
 if(scenario==='kill'){assert.equal(killed,true,'Actual worker process must die after consuming a permit');await wait(2200);}
 for(let n=0;n<3;n++){cli('mautic:campaigns:trigger','-i',String(native.campaign));worker();}
 const after=await status(),intent=after.intents[0];
 const deliveries=after.deliveries.filter(d=>d.id===intent.intent);
 assert.equal(deliveries.length,scenario==='deliver'?1:0);
 const operation=authority('harness:operation',{token:config.fixture.A.sessions.owner,id:intent.operation});
 if(scenario==='kill')assert.equal(operation.state,'outcomeUnknown');
 if(scenario==='deliver')assert.equal(operation.state,'confirmed');
 if(scenario==='unapproved')assert.equal(operation.state,'proposed');
 results.push({scenario,status:'PASS',nativeLog:intent.occurrence.log,rotation:intent.occurrence.rotation,operationState:operation.state,bridgeState:intent.state,deliveries:deliveries.length,workerKilled:killed,additionalCronPasses:3});
 console.log('PASS '+scenario+': deliveries '+deliveries.length+', operation '+operation.state);
}
writeFileSync(directory+'evidence/safety.json',JSON.stringify({level:'SERVICE Mautic/Doctrine/Convex with explicit test-driver approval of each exact queued operation and local HTTP sink; no real mail',results,limits:['Only one synthetic Mautic instance','Source/binding/workflow mapping is fixture operator configuration, not production identity integration','Automated approved campaign-version to per-recipient intent translation remains open','One-second Doctrine redelivery timeout is a fault-test override; not production policy','Engagement branch execution, frequency queue and full P2/S4 remain open']},null,2)+'\n');
