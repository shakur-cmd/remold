import assert from 'node:assert/strict';
import {execFileSync,spawn,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {docker,directory,prefix,context} from './runtime.mjs';
import {authority} from './authority.mjs';
import {received,oracle} from './receiver-evidence.mjs';
const results=[],only=process.argv[2],wait=ms=>new Promise(r=>setTimeout(r,ms));
const cli=(...args)=>docker(['exec','--user','www-data',prefix+'-web-a','php','/var/www/html/bin/console',...args]);
const run=(file,args=[])=>execFileSync(process.execPath,[directory+file,...args],{stdio:'pipe'});
for(const scenario of only?[only]:['late-approval','sink-refused','sink-busy','lost-response','receiver-lost-response','concurrent-workers']){
 run('native-fixture.mjs');run('setup-bridge.mjs',['--rearm',...(scenario==='sink-refused'?['--sink-refused-once']:scenario==='sink-busy'?['--sink-busy-once']:scenario==='lost-response'?['--lost-sink-response-once']:scenario==='receiver-lost-response'?['--sink-commits-then-drops']:[])]);
 const native=JSON.parse(readFileSync(directory+'private/native-fixture.json')),config=JSON.parse(readFileSync(directory+'private/bridge-config.json'));
 const status=async()=>{const r=await fetch('http://127.0.0.1:3542/status',{method:'POST',headers:{'x-remold-key':config.bridgeKey},body:'{}'});assert.equal(r.status,200);const v=await r.json();return {...v,intents:v.intents.filter(x=>x.occurrence.lead===native.contact)};};
 for(let n=0;n<30;n++){try{await status();break;}catch(e){if(n===29)throw e;await wait(100);}}
 cli('mautic:campaigns:update','-i',String(native.campaign));cli('mautic:campaigns:trigger','-i',String(native.campaign));
 const queued=(await status()).intents[0];assert.equal(queued.state,'sealed');
 const approve=()=>authority('harness:approve',{token:config.fixture.A.sessions.owner,id:queued.operation,expires:Date.now()+3600000});
 const lost=['lost-response','receiver-lost-response'].includes(scenario);
 const workerArgs=['exec','--user','www-data','-e','MAUTIC_MESSENGER_DSN_EMAIL=doctrine://default?redeliver_timeout=1',prefix+'-web-a','php','/var/www/html/bin/console','messenger:consume','email',lost?'--limit=1':'--limit=100','--time-limit=3','--no-interaction','-vv'];
 const worker=()=>{const value=spawnSync('docker',['--context',context,...workerArgs],{encoding:'utf8'});assert.equal(value.status,0,'Doctrine worker exit');return value.stdout+value.stderr;};
 const concurrentWorker=()=>new Promise((resolve,reject)=>{const p=spawn('docker',['--context',context,...workerArgs]);let out='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>out+=x);p.on('error',reject);p.on('exit',code=>code===0?resolve(out):reject(Error('Worker exit '+code)));});
 const records=()=>docker(['exec',prefix+'-web-a','cat','/var/www/html/var/logs/remold-capture.jsonl']).trim().split('\n').map(s=>JSON.parse(s)).filter(x=>x.intent===queued.intent);
 const accepted=()=>records().filter(x=>x.kind==='transport-accepted').length;
 if(scenario==='late-approval'){worker();assert.ok(records().some(x=>x.kind==='transport-observed'),'First worker must actually attempt this intent before approval');}
 const beforeApproval=(await status()).intents[0].state;
 approve();
 if(scenario==='concurrent-workers'){
  const sql=query=>docker(['exec',prefix+'-db-a','sh','-c','MYSQL_PWD="$MYSQL_PASSWORD" mysql -u "$MYSQL_USER" "$MYSQL_DATABASE" -NB -e "$1"','--',query]).trim();
  assert.match(queued.intent,/^[a-f0-9]{64}$/);
  assert.equal(Number(sql("SELECT COUNT(*) FROM messenger_messages WHERE queue_name='default' AND body LIKE '%"+queued.intent+"%'")),1);
  sql("INSERT INTO messenger_messages(body,headers,queue_name,created_at,available_at,delivered_at) SELECT body,headers,queue_name,NOW(),NOW(),NULL FROM messenger_messages WHERE queue_name='default' AND body LIKE '%"+queued.intent+"%' LIMIT 1");
 }
 const logs=scenario==='concurrent-workers'?await Promise.all([concurrentWorker(),concurrentWorker()]):[worker()];
 if(lost)for(let n=0;n<30&&!records().some(x=>x.kind==='transport-unconfirmed');n++)logs.push(worker());
 writeFileSync(directory+'private/reliability-'+scenario+'-workers.log',logs.join('\n'),{mode:0o600});
 const first=await status(),firstAccepted=accepted();
 const receiverBefore=received(queued.intent);
 if(lost){assert.equal(firstAccepted,0,'Lost first response must not ACK');assert.equal(receiverBefore.attempts.filter(x=>x.outcome==='accepted').length,1);assert.equal(authority('harness:operation',{token:config.fixture.A.sessions.owner,id:queued.operation}).receipts.length,0);if(scenario==='receiver-lost-response'){assert.equal(first.intents[0].state,'sink-unknown');assert.equal(first.deliveries.filter(x=>x.id===queued.intent).length,0);docker(['restart',prefix+'-mime-sink']);}docker(['restart',prefix+'-bridge']);for(let n=0;n<30;n++){try{await status();break;}catch(e){if(n===29)throw e;await wait(100);}}}
 await wait(1500);
 for(let n=0;n<(lost?30:2);n++){worker();if(lost&&accepted()>0)break;}
 const after=await status(),intent=after.intents[0],operation=authority('harness:operation',{token:config.fixture.A.sessions.owner,id:intent.operation});
 const result={scenario,beforeApproval,first:{state:first.intents[0].state,deliveries:first.deliveries.filter(d=>d.id===intent.intent).length,transportAccepted:firstAccepted},after:{state:intent.state,deliveries:after.deliveries.filter(d=>d.id===intent.intent).length,operation:operation.state,h0Receipts:operation.receipts.length,transportAccepted:accepted()},workersSimultaneous:scenario==='concurrent-workers'?2:0,duplicateQueueFault:scenario==='concurrent-workers',transportFailures:records().filter(x=>x.kind==='transport-unconfirmed').length};
 try{
  if(scenario==='sink-refused'){assert.equal(result.first.transportAccepted,0,'A refused sink must not count as transport accepted');assert.equal(result.after.deliveries,0);}
  else{const receipt=received(intent.intent),parsed=oracle(receipt);assert.equal(parsed.hash,intent.hash);assert.deepEqual(receipt.attempts,[{outcome:'accepted'}],'Recovery and duplicate workers must never POST bytes twice');if(lost)assert.equal(receipt.raw_sha,receiverBefore.raw_sha);result.receiver={acceptedPosts:1,totalPosts:receipt.attempts.length,rawSha256:parsed.rawSha256,normalizedHash:parsed.hash,independentPythonMime:true};if(lost)assert.ok(result.transportFailures>0,'Actual worker must emit a failed transport event after the lost sink response');assert.equal(result.after.deliveries,1,'Late approval or recoverable receipt must deliver exactly once');assert.equal(result.after.operation,'confirmed');assert.equal(result.after.h0Receipts,1);}
  result.status='PASS';
 }catch(e){result.status='FAIL';result.error=e.message;process.exitCode=1;}
 results.push(result);console.log(JSON.stringify(result));
}
writeFileSync(directory+'evidence/reliability'+(only?'-'+only:'')+'.json',JSON.stringify({level:'SERVICE Mautic Doctrine workers, H0, separate internal HTTP receiver with stored MIME and independent Python oracle; no SMTP or external mail',results},null,2)+'\n');
