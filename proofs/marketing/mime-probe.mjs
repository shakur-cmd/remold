import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {docker,directory,prefix} from './runtime.mjs';
import {authority} from './authority.mjs';
const run=(file,args=[])=>execFileSync(process.execPath,[directory+file,...args],{stdio:'pipe'});
run('verify-runtime.mjs');run('install-plugin.mjs');run('native-fixture.mjs');run('setup-bridge.mjs',['--rearm']);
const native=JSON.parse(readFileSync(directory+'private/native-fixture.json')),config=JSON.parse(readFileSync(directory+'private/bridge-config.json'));
const status=async()=>{const r=await fetch('http://127.0.0.1:3542/status',{method:'POST',headers:{'x-remold-key':config.bridgeKey},body:'{}'});assert.equal(r.status,200);return r.json();};
for(let n=0;n<20;n++){try{await status();break;}catch(e){if(n===19)throw e;await new Promise(r=>setTimeout(r,100));}}
const cli=(...args)=>docker(['exec','--user','www-data','-e','REMOLD_MIME_PROBE=1','-e','MAUTIC_MESSENGER_DSN_EMAIL=doctrine://default?redeliver_timeout=1',prefix+'-web-a','php','/var/www/html/bin/console',...args]);
cli('mautic:campaigns:update','-i',String(native.campaign));cli('mautic:campaigns:trigger','-i',String(native.campaign));
const queued=(await status()).intents.filter(i=>i.occurrence.lead===native.contact);assert.equal(queued.length,1);const intent=queued[0];
const probes=()=>docker(['exec',prefix+'-web-a','cat','/var/www/html/var/logs/remold-mime-probe.jsonl']).trim().split('\n').map(JSON.parse).filter(p=>p.intent===intent.intent);
for(let n=0;n<6&&probes().filter(p=>p.stage==='transport').length<2;n++){cli('messenger:consume','email','--limit=20','--time-limit=3','--no-interaction');await new Promise(r=>setTimeout(r,2200));}
const rows=probes();assert.equal(rows.filter(p=>p.stage==='queued').length,1);assert(rows.filter(p=>p.stage==='transport').length>=2,'Two real worker attempts required');
const after=await status();assert.equal(after.deliveries.filter(r=>r.id===intent.intent).length,0);assert.equal(authority('harness:operation',{token:config.fixture.A.sessions.owner,id:intent.operation}).state,'proposed');
writeFileSync(directory+'private/mime-probe.json',JSON.stringify({intent:intent.intent,operation:intent.operation,sealedHash:intent.hash,rows},null,2)+'\n',{mode:0o600});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
writeFileSync(directory+'evidence/mime/probe.json',JSON.stringify({level:'SERVICE actual Mautic queue and worker attempts; no delivery',intent:intent.intent,operation:intent.operation,sealedHash:intent.hash,rows:rows.map(p=>({stage:p.stage,rawSha256:hash(Buffer.from(p.raw,'base64')),bytes:Buffer.from(p.raw,'base64').length})),deliveries:0,operationState:'proposed'},null,2)+'\n');
console.log('PASS captured queued MIME and '+rows.filter(p=>p.stage==='transport').length+' actual worker attempts; zero deliveries/consumptions');
