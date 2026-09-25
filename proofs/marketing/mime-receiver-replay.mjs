import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {docker,directory,prefix} from './runtime.mjs';
import {authority} from './authority.mjs';
import {received,oracle} from './receiver-evidence.mjs';
for(const [file,...args] of [['native-fixture.mjs'],['setup-bridge.mjs','--rearm']])execFileSync(process.execPath,[directory+file,...args],{stdio:'pipe'});
const native=JSON.parse(readFileSync(directory+'private/native-fixture.json')),config=JSON.parse(readFileSync(directory+'private/bridge-config.json'));
const status=async()=>{const r=await fetch('http://127.0.0.1:3542/status',{method:'POST',headers:{'x-remold-key':config.bridgeKey},body:'{}'});assert.equal(r.status,200);return r.json();};
for(let n=0;n<30;n++){try{await status();break;}catch(e){if(n===29)throw e;await new Promise(r=>setTimeout(r,100));}}
const cli=(...args)=>docker(['exec','--user','www-data',prefix+'-web-a','php','/var/www/html/bin/console',...args]);
cli('mautic:campaigns:update','-i',String(native.campaign));cli('mautic:campaigns:trigger','-i',String(native.campaign));
const intent=(await status()).intents.find(x=>x.occurrence.lead===native.contact);assert.equal(intent.state,'sealed');
authority('harness:approve',{token:config.fixture.A.sessions.owner,id:intent.operation,expires:Date.now()+3600000});
cli('messenger:consume','email','--limit=100','--time-limit=3','--no-interaction');
const receipt=received(intent.intent),checked=oracle(receipt),operation=authority('harness:operation',{token:config.fixture.A.sessions.owner,id:intent.operation});
assert.equal(checked.hash,intent.hash);assert.equal(operation.payload.content,checked.hash);assert.equal(operation.receipts.length,1);assert.equal(operation.state,'confirmed');assert.deepEqual(receipt.attempts,[{outcome:'accepted'}]);
// Run direct adversarial requests from the bridge network, using its existing scoped receiver key.
const script=`import fs from 'node:fs';const c=JSON.parse(fs.readFileSync('/config.json'));const a=JSON.parse(fs.readFileSync('/mime-challenge.json'));const r=await fetch('http://mime-sink:3543/deliver',{method:'POST',headers:{'x-remold-sink-key':c.sinkKey},body:JSON.stringify(a)});console.log(r.status);`;
const payload={intent:intent.intent,raw:receipt.raw,sender:receipt.sender,recipient:receipt.recipient,recipients:1,expected:intent.hash};
const change=(from,to)=>({...payload,raw:Buffer.from(Buffer.from(payload.raw,'base64').toString('ascii').replace(from,to),'ascii').toString('base64')});
const raw=Buffer.from(payload.raw,'base64').toString('ascii'),bodyAt=raw.indexOf('\r\n\r\n',raw.indexOf('\r\n\r\n')+4)+4;
const cases=[['body',{...payload,raw:Buffer.from(raw.slice(0,bodyAt)+'Changed body. '+raw.slice(bodyAt),'ascii').toString('base64')}],['subject',change('Subject:','Subject: Changed ')],['bcc',change('Subject:','Bcc: hidden@example.invalid\r\nSubject:')],['to',change(receipt.recipient,'other@example.invalid')],['envelope-recipient',{...payload,recipient:'other@example.invalid'}],['sender',{...payload,sender:'other@example.invalid'}],['duplicate',payload]];
for(const [name,value] of cases){
 writeFileSync(directory+'private/mime-challenge.json',JSON.stringify(value),{mode:0o600});docker(['cp',directory+'private/mime-challenge.json',prefix+'-bridge:/mime-challenge.json']);
 assert.equal(Number(docker(['exec',prefix+'-bridge','node','--input-type=module','-e',script])),409,name+' must be refused');
 const after=received(intent.intent);assert.ok(after.raw===receipt.raw,'Stored MIME bytes must remain unchanged');assert.equal(after.raw_sha,receipt.raw_sha);assert.equal(after.attempts.at(-1).outcome,name==='duplicate'?'duplicate-refused':'refused');
}
const after=received(intent.intent);assert.equal(after.attempts.length,8);
writeFileSync(directory+'evidence/mime/receiver.json',JSON.stringify({level:'SERVICE actual native MIME stored by separate internal HTTP receiver; no SMTP/mailbox',status:'PASS',oracle:checked,approvedHash:intent.hash,h0Receipts:1,storedDeliveries:1,acceptedPosts:1,refusedMutations:cases.slice(0,-1).map(x=>x[0]),duplicatePostRefused:true,storedBytesUnchanged:true},null,2)+'\n');
console.log('PASS native MIME receipt independently parsed, six mutations refused and duplicate POST cannot alter stored bytes.');
