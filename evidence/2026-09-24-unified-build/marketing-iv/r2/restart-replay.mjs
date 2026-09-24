import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {docker, directory, prefix, context} from '../../../../proofs/marketing/runtime.mjs';
import {authority} from '../../../../proofs/marketing/authority.mjs';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = (file,args=[]) => execFileSync(process.execPath,[directory+file,...args],{stdio:'pipe'});
const cli = (...args) => docker(['exec','--user','www-data',prefix+'-web-a','php','/var/www/html/bin/console',...args]);
const result = {scope:'Synthetic lost-response recovery across bridge restart only',startedAt:new Date().toISOString()};
const output = new URL(process.argv[2] ?? './restart-result.json', import.meta.url);
try {
  run('native-fixture.mjs'); run('setup-bridge.mjs',['--rearm','--lost-sink-response-once']);
  const native=JSON.parse(readFileSync(directory+'private/native-fixture.json'));
  const config=JSON.parse(readFileSync(directory+'private/bridge-config.json'));
  const status=async()=>{
    const r=await fetch('http://127.0.0.1:3542/status',{method:'POST',headers:{'x-remold-key':config.bridgeKey},body:'{}'});
    assert.equal(r.status,200); const value=await r.json();
    return {...value,intents:value.intents.filter(x=>x.occurrence.lead===native.contact)};
  };
  const ready=async()=>{for(let i=0;i<30;i++){try{await status();return;}catch(e){if(i===29)throw e;await wait(100);}}};
  await ready(); cli('mautic:campaigns:update','-i',String(native.campaign));cli('mautic:campaigns:trigger','-i',String(native.campaign));
  const intent=(await status()).intents[0]; assert.equal(intent.state,'sealed');
  result.native={contact:native.contact,campaign:native.campaign,log:intent.occurrence.log,intent:intent.intent};
  authority('harness:approve',{token:config.fixture.A.sessions.owner,id:intent.operation,expires:Date.now()+3600000});
  const events=()=>docker(['exec',prefix+'-web-a','cat','/var/www/html/var/logs/remold-capture.jsonl']).trim().split('\n').map(JSON.parse).filter(x=>x.intent===intent.intent);
  const worker=()=>{
    const p=spawnSync('docker',['--context',context,'exec','--user','www-data','-e','MAUTIC_MESSENGER_DSN_EMAIL=doctrine://default?redeliver_timeout=1',prefix+'-web-a','php','/var/www/html/bin/console','messenger:consume','email','--limit=1','--time-limit=3','--no-interaction'],{encoding:'utf8'});
    assert.equal(p.status,0,'Single-message worker must exit normally after transport failure');
  };
  // Old synthetic queue work can precede this fixture. Each process handles at most one message.
  for(let i=0;i<20 && !events().some(e=>e.kind==='transport-unconfirmed');i++)worker();
  assert(events().some(e=>e.kind==='transport-unconfirmed'),'The target must fail before restart');
  const snapshot=async()=>{
    const value=await status(),row=value.intents[0];
    const op=authority('harness:operation',{token:config.fixture.A.sessions.owner,id:row.operation});
    return {bridgeState:row.state,deliveries:value.deliveries.filter(x=>x.id===intent.intent).length,operationState:op.state,h0Receipts:op.receipts.length,transportAccepted:events().filter(e=>e.kind==='transport-accepted').length,transportFailures:events().filter(e=>e.kind==='transport-unconfirmed').length};
  };
  result.beforeRestart=await snapshot();
  assert(['dispatching','outcomeUnknown'].includes(result.beforeRestart.operationState));
  assert.equal(result.beforeRestart.deliveries,1);assert.equal(result.beforeRestart.h0Receipts,0);assert.equal(result.beforeRestart.transportAccepted,0);
  docker(['restart',prefix+'-bridge']);await ready();
  result.afterRestartBeforeRetry=await snapshot();
  assert.equal(result.afterRestartBeforeRetry.deliveries,1);assert.equal(result.afterRestartBeforeRetry.h0Receipts,0);assert.equal(result.afterRestartBeforeRetry.transportAccepted,0);
  await wait(1500);
  for(let i=0;i<20 && (await snapshot()).operationState!=='confirmed';i++)worker();
  result.afterRecovery=await snapshot();
  assert.equal(result.afterRecovery.deliveries,1);assert.equal(result.afterRecovery.h0Receipts,1);assert.equal(result.afterRecovery.operationState,'confirmed');assert.equal(result.afterRecovery.transportAccepted,1);
  worker();worker(); result.afterExtraWorkers=await snapshot();
  assert.equal(result.afterExtraWorkers.deliveries,1);assert.equal(result.afterExtraWorkers.h0Receipts,1);
  result.status='PASS';
} catch(error) { result.status='FAIL';result.error=String(error);process.exitCode=1; }
finally {writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result,null,2));}
