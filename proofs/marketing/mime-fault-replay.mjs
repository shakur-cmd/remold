import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {docker,directory,prefix} from './runtime.mjs';
import {authority} from './authority.mjs';
import {inspectMime} from './mime.mjs';
import {received} from './receiver-evidence.mjs';
const results=[];
for(const scenario of (process.argv[2]?[process.argv[2]]:['body-after-consume','subject-before-consume','reconcile-collision'])){
 for(const [file,...args] of [['native-fixture.mjs'],['setup-bridge.mjs','--rearm']])execFileSync(process.execPath,[directory+file,...args],{stdio:'pipe'});
 const native=JSON.parse(readFileSync(directory+'private/native-fixture.json')),config=JSON.parse(readFileSync(directory+'private/bridge-config.json'));
 const call=(path,value)=>fetch('http://127.0.0.1:3542'+path,{method:'POST',headers:{'x-remold-key':config.bridgeKey},body:JSON.stringify(value)});
 const status=async()=>{const r=await call('/status',{});assert.equal(r.status,200);return r.json();};
 for(let n=0;n<30;n++){try{await status();break;}catch(e){if(n===29)throw e;await new Promise(r=>setTimeout(r,100));}}
 const cli=(args,env=[])=>docker(['exec','--user','www-data','-e','REMOLD_MIME_PROBE=1',...env.flatMap(x=>['-e',x]),prefix+'-web-a','php','/var/www/html/bin/console',...args]);
 cli(['mautic:campaigns:update','-i',String(native.campaign)]);cli(['mautic:campaigns:trigger','-i',String(native.campaign)]);
 const intent=(await status()).intents.find(x=>x.occurrence.lead===native.contact);assert.equal(intent.state,'sealed');
 const probe=docker(['exec',prefix+'-web-a','cat','/var/www/html/var/logs/remold-mime-probe.jsonl']).trim().split('\n').map(JSON.parse).find(x=>x.intent===intent.intent&&x.stage==='queued');assert.ok(probe);
 const payload={intent:intent.intent,raw:probe.raw,sender:probe.sender,recipient:probe.recipients[0],recipients:1};assert.equal(inspectMime(payload).hash,intent.hash);
 authority('harness:approve',{token:config.fixture.A.sessions.owner,id:intent.operation,expires:Date.now()+3600000});
 if(scenario==='body-after-consume'){
  assert.equal((await call('/authorize',payload)).status,200);
  const text=Buffer.from(payload.raw,'base64').toString('ascii'),at=text.indexOf('\r\n\r\n',text.indexOf('\r\n\r\n')+4)+4;
  const changed={...payload,raw:Buffer.from(text.slice(0,at)+'Changed approved body. '+text.slice(at),'ascii').toString('base64')};
  assert.notEqual(inspectMime(changed).hash,intent.hash);assert.equal((await call('/sink',changed)).status,409);
 }
 if(scenario==='reconcile-collision'){
  assert.equal((await call('/authorize',payload)).status,200);
  const consumed=(await status()).intents.find(x=>x.intent===intent.intent);
  authority('harness:reconcile',{token:config.fixture.A.adapter,id:intent.operation,...consumed.claim,providerRef:'synthetic-conflicting-receipt',usage:0});
  assert.equal((await call('/sink',payload)).status,409,'An H0 receipt collision must not report successful acknowledgement');
 }
 const env=scenario==='subject-before-consume'?['REMOLD_MIME_FAULT_INTENT='+intent.intent]:[];
 for(let n=0;n<2;n++)cli(['messenger:consume','email','--limit=100','--time-limit=3','--no-interaction'],env);
 const after=(await status()).intents.find(x=>x.intent===intent.intent),operation=authority('harness:operation',{token:config.fixture.A.sessions.owner,id:intent.operation}),receiver=received(intent.intent);
 const records=docker(['exec',prefix+'-web-a','cat','/var/www/html/var/logs/remold-capture.jsonl']).trim().split('\n').map(JSON.parse).filter(x=>x.intent===intent.intent);
 assert.ok(records.some(x=>x.kind==='transport-unconfirmed'));assert.ok(!records.some(x=>x.kind==='transport-accepted'));
 if(scenario==='reconcile-collision'){assert.ok(receiver.raw);assert.deepEqual(receiver.attempts,[{outcome:'accepted'}]);assert.equal(operation.receipts.length,1);assert.equal(operation.receipts[0].providerRef,'synthetic-conflicting-receipt');assert.equal(after.state,'delivered');}
 else{assert.ok(!receiver.raw,'Mutated message must not reach receiver');assert.equal(receiver.attempts.length,0);assert.equal(operation.receipts.length,0);if(scenario==='subject-before-consume'){assert.ok(records.some(x=>x.kind==='fixture-subject-mutated'));assert.equal(after.state,'sealed');assert.equal(operation.state,'approved');}else assert.equal(after.state,'consumed');}
 results.push({scenario,status:'PASS',intent:intent.intent,normalizedHash:intent.hash,bridgeState:after.state,authorityState:operation.state,receiverPosts:receiver.attempts.length,receiverDeliveries:receiver.raw?1:0,h0Receipts:operation.receipts.length,conflictingSyntheticReceipt:scenario==='reconcile-collision',transportAccepted:0,failedMessageEvents:records.filter(x=>x.kind==='transport-unconfirmed').length});
 console.log('PASS '+scenario+': no false transport acknowledgement; receiver deliveries '+(receiver.raw?1:0));
}
writeFileSync(directory+'evidence/mime/faults'+(process.argv[2]?'-'+process.argv[2]:'')+'.json',JSON.stringify({level:'SERVICE native Mautic queue and local authority/receiver only',results},null,2)+'\n');
