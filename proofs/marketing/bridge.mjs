import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {timingSafeEqual} from 'node:crypto';
import {inspectMime} from './mime.mjs';
const config=JSON.parse(readFileSync('/config.json','utf8'));
// The earlier hash-only fixture remains intact in guard.sqlite; this is a new bounded proof namespace.
const db=new DatabaseSync('/data/mime-guard.sqlite');
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, hash TEXT NOT NULL, receipt TEXT NOT NULL);');
const get=id=>{const r=db.prepare('SELECT value FROM intents WHERE id=?').get(id);return r?JSON.parse(r.value):null;};
const save=(id,v)=>db.prepare('INSERT INTO intents VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id,JSON.stringify(v));
const h=async(name,args,kind='mutation')=>{const r=await fetch('http://authority:3210/api/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'harness:'+name,args,format:'json'})});const v=await r.json();if(!r.ok||v.status!=='success')throw Error('Authority refused '+name);return v.value;};
async function sink(path,payload){
 const r=await fetch('http://mime-sink:3543'+path,{method:payload?'POST':'GET',headers:{'x-remold-sink-key':config.sinkKey,'Content-Type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(5000)});
 if(!payload&&r.status===404)return null;if(!r.ok)throw Error('Private MIME receiver refused or unavailable');return r.json();
}
function recordReceipt(id,row,receipt){
 if(!receipt||receipt.intent!==id||receipt.hash!==row.hash||receipt.rawSha256!==row.forwardRawHash||receipt.sender!==row.sender||receipt.recipient!==row.recipient)throw Error('Receiver receipt mismatch');
 const prior=db.prepare('SELECT receipt FROM deliveries WHERE id=?').get(id);if(prior&&prior.receipt!==JSON.stringify(receipt))throw Error('Receiver receipt changed');
 db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT OR IGNORE INTO deliveries VALUES(?,?,?)').run(id,row.hash,JSON.stringify(receipt));save(id,{...row,state:'delivered'});db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
 return receipt;
}
async function knownReceipt(id,row){
 if(!row.forwardRawHash)return null;
 const stored=db.prepare('SELECT receipt FROM deliveries WHERE id=?').get(id),receipt=stored?JSON.parse(stored.receipt):await sink('/receipts/'+id);
 return receipt?recordReceipt(id,row,receipt):null;
}
async function acknowledge(id,row){
 const receipt=await knownReceipt(id,row);if(!receipt)throw Error('No independent delivery receipt');
 const reconciled=await h('reconcile',{token:config.fixture.A.adapter,id:row.operation,...row.claim,providerRef:'local-mime-sink:'+receipt.rawSha256,usage:0});if(reconciled.accepted!==true)throw Error('Authority refused delivery receipt');return {delivered:true,rawSha256:receipt.rawSha256};
}
let inFlight=false;
async function route(path,a){
 if(path==='/capture'){
  if(a.instance!=='synthetic-a'||a.lead!==config.contact||!config.events.includes(a.event)||!Number.isSafeInteger(a.log)||a.log<=0||!Number.isSafeInteger(a.rotation)||a.rotation<=0||!/^[a-f0-9]{64}$/.test(a.intent))throw Error('Unapproved native occurrence');
  const old=get(a.intent);if(old){if(JSON.stringify(old.occurrence)!==JSON.stringify(a))throw Error('Occurrence collision');return {intent:a.intent};}
  if(db.prepare('SELECT COUNT(*) AS n FROM intents').get().n>=128)throw Error('Fixture intent bound reached');
  save(a.intent,{occurrence:a,state:'captured'});return {intent:a.intent};
 }
 if(path==='/status')return {intents:db.prepare('SELECT id,value FROM intents').all().map(r=>({intent:r.id,...JSON.parse(r.value)})),deliveries:db.prepare('SELECT id,hash,receipt FROM deliveries').all().map(r=>({...r,receipt:JSON.parse(r.receipt)}))};
 const row=get(a.intent);if(!row)throw Error('Missing approved occurrence');
 if(path==='/ack'){if(Object.keys(a).join(',')!=='intent'||row.state!=='delivered')throw Error('Receipt-only acknowledgement required');return acknowledge(a.intent,row);}
 const mime=inspectMime(a),f=config.fixture.A;
 if(mime.sender!==config.sender||mime.recipient!==config.recipient)throw Error('Envelope outside fixture');
 if(path==='/seal'){
  if(row.hash){if(row.hash!==mime.hash)throw Error('Sealed content changed');return {sealed:true};}
  const payload={content:mime.hash,audience:['recipient'],audienceVersion:1,destination:f.key.account,schedule:0,amountMinor:0,currency:'usd',workflowVersion:config.workflowVersion};
  const operation=await h('propose',{token:f.sessions.child,logical:a.intent,binding:f.binding,capability:'marketing.send',payload,reservationUnits:1,maxSteps:1});
  save(a.intent,{...row,hash:mime.hash,sender:mime.sender,recipient:mime.recipient,operation,state:'sealed'});return {sealed:true};
 }
 if(row.hash!==mime.hash||row.sender!==mime.sender||row.recipient!==mime.recipient)throw Error('Sealed content or envelope changed');
 if(path==='/authorize'){
  // Retry bytes are checked at the authority bridge, but an existing receipt never permits another receiver POST.
  if(await knownReceipt(a.intent,row))return {receiptOnly:true};
  if(row.state!=='sealed')throw Error('Occurrence already dispatched or unresolved');
  const operation=await h('operation',{token:f.sessions.child,id:row.operation},'query');if(operation.state==='proposed')throw Error('Human approval pending');
  save(a.intent,{...row,state:'dispatching'});
  try{
   const worker='synthetic-mautic-worker',claim=await h('claim',{token:f.sessions.child,id:row.operation,worker});save(a.intent,{...row,state:'dispatching',claim});
   const permit=await h('permit',{token:f.adapter,id:row.operation,worker,...claim});await h('consume',{token:f.adapter,id:row.operation,worker,...claim,version:permit.version,binding:f.binding});
   save(a.intent,{...row,state:'consumed',claim});return {consumed:true,kill:config.killAfterConsume===true};
  }catch{save(a.intent,{...get(a.intent),state:'refused-or-unknown'});throw Error('Current authority refused or unresolved');}
 }
 if(path==='/sink'){
  if(await knownReceipt(a.intent,row))return acknowledge(a.intent,get(a.intent));
  if(row.state!=='consumed')throw Error('Receiver requires one consumed occurrence');
  if(config.sinkRefusedOnce&&!row.fixtureRefused){save(a.intent,{...row,fixtureRefused:true});throw Error('Synthetic sink refused before effect');}
  if(config.sinkBusyOnce&&!row.fixtureBusy){save(a.intent,{...row,fixtureBusy:true});return {fixtureBusy:true};}
  const forwarding={...row,state:'forwarding',forwardRawHash:mime.rawSha256};save(a.intent,forwarding);
  let receipt;try{receipt=await sink('/deliver',{...a,expected:row.hash});}catch{save(a.intent,{...forwarding,state:'sink-unknown'});throw Error('Independent receiver outcome unknown; lookup only');}
  recordReceipt(a.intent,forwarding,receipt);
  if(config.lostSinkResponseOnce)return {fixtureLostResponse:true};
  return acknowledge(a.intent,get(a.intent));
 }
 throw Error('Unknown bridge route');
}
const server=createServer(async(req,res)=>{
 const key=Buffer.from(String(req.headers['x-remold-key']??'')),expected=Buffer.from(config.bridgeKey);
 if(key.length!==expected.length||!timingSafeEqual(key,expected)){res.writeHead(403);res.end('{}');return;}
 if(req.method!=='POST'){res.writeHead(405);res.end('{}');return;}
 if(inFlight){res.writeHead(503);res.end('{"busy":true}');return;}
 let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>65536){res.writeHead(413);res.end('{}');return;}}
 if(inFlight){res.writeHead(503);res.end('{"busy":true}');return;}inFlight=true;
 try{const value=await route(req.url,JSON.parse(body));if(value.fixtureLostResponse){res.destroy();return;}if(value.fixtureBusy){res.writeHead(503);res.end('{"busy":true}');return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));}
 catch{res.writeHead(409,{'Content-Type':'application/json'});res.end('{"refused":true}');}
 finally{inFlight=false;}
});
server.listen(3542,'0.0.0.0',()=>console.log('Synthetic MIME authority bridge ready; independent internal receiver only.'));
