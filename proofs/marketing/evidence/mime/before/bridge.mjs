import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {timingSafeEqual} from 'node:crypto';
const config=JSON.parse(readFileSync('/config.json','utf8'));
const db=new DatabaseSync('/data/guard.sqlite');
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY, hash TEXT NOT NULL);');
const get=id=>{const r=db.prepare('SELECT value FROM intents WHERE id=?').get(id);return r?JSON.parse(r.value):null;};
const save=(id,v)=>db.prepare('INSERT INTO intents VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id,JSON.stringify(v));
const h=async(name,args,kind='mutation')=>{const r=await fetch('http://authority:3210/api/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'harness:'+name,args,format:'json'})});const v=await r.json();if(!r.ok||v.status!=='success')throw Error('Authority refused '+name);return v.value;};
let inFlight=false;
async function route(path,a){
 if(path==='/capture'){
  if(a.instance!=='synthetic-a'||a.lead!==config.contact||!config.events.includes(a.event)||!Number.isSafeInteger(a.log)||a.log<=0||!Number.isSafeInteger(a.rotation)||a.rotation<=0||!/^[a-f0-9]{64}$/.test(a.intent))throw Error('Unapproved native occurrence');
  const old=get(a.intent);if(old){if(JSON.stringify(old.occurrence)!==JSON.stringify(a))throw Error('Occurrence collision');return {intent:a.intent};}
  if(db.prepare('SELECT COUNT(*) AS n FROM intents').get().n>=128)throw Error('Fixture intent bound reached');
  save(a.intent,{occurrence:a,state:'captured'});return {intent:a.intent};
 }
 if(path==='/status')return {intents:db.prepare('SELECT id,value FROM intents').all().map(r=>({intent:r.id,...JSON.parse(r.value)})),deliveries:db.prepare('SELECT id,hash FROM deliveries').all()};
 const row=get(a.intent);if(!row)throw Error('Missing approved occurrence');
 if(typeof a.hash!=='string'||!/^[a-f0-9]{64}$/.test(a.hash)||a.recipient!==config.recipient||a.recipients!==1)throw Error('Payload or recipient mismatch');
 const f=config.fixture.A;
 if(path==='/seal'){
  if(row.hash){if(row.hash!==a.hash)throw Error('Sealed content changed');return {sealed:true};}
  const payload={content:a.hash,audience:['recipient'],audienceVersion:1,destination:f.key.account,schedule:0,amountMinor:0,currency:'usd',workflowVersion:config.workflowVersion};
  const operation=await h('propose',{token:f.sessions.child,logical:a.intent,binding:f.binding,capability:'marketing.send',payload,reservationUnits:1,maxSteps:1});
  save(a.intent,{...row,hash:a.hash,operation,state:'sealed'});return {sealed:true};
 }
 if(row.hash!==a.hash)throw Error('Sealed content changed');
 if(path==='/authorize'){
  // A durable receipt may be acknowledged again; it never authorizes a new effect.
  if(row.state==='delivered'&&db.prepare('SELECT hash FROM deliveries WHERE id=?').get(a.intent)?.hash===a.hash)return {receiptOnly:true};
  if(row.state!=='sealed')throw Error('Occurrence already dispatched or unresolved');
  const operation=await h('operation',{token:f.sessions.child,id:row.operation},'query');
  if(operation.state==='proposed')throw Error('Human approval pending');
  // Persist before network work. Any process death leaves a non-retryable hold.
  save(a.intent,{...row,state:'dispatching'});
  try{
   const worker='synthetic-mautic-worker';const claim=await h('claim',{token:f.sessions.child,id:row.operation,worker});
   save(a.intent,{...row,state:'dispatching',claim});
   const permit=await h('permit',{token:f.adapter,id:row.operation,worker,...claim});
   await h('consume',{token:f.adapter,id:row.operation,worker,...claim,version:permit.version,binding:f.binding});
   save(a.intent,{...row,state:'consumed',claim});return {consumed:true,kill:config.killAfterConsume===true};
  }catch{save(a.intent,{...get(a.intent),state:'refused-or-unknown'});throw Error('Current authority refused or unresolved');}
 }
 if(path==='/sink'){
  const receipt=db.prepare('SELECT hash FROM deliveries WHERE id=?').get(a.intent);
  if(receipt){if(receipt.hash!==a.hash||row.state!=='delivered')throw Error('Inconsistent receipt');}
  else{
   if(row.state!=='consumed')throw Error('Sink requires one consumed occurrence');
   // Synthetic proof faults only: no provider or production transport uses these switches.
   if(config.sinkRefusedOnce&&!row.fixtureRefused){save(a.intent,{...row,fixtureRefused:true});throw Error('Synthetic sink refused before effect');}
   if(config.sinkBusyOnce&&!row.fixtureBusy){save(a.intent,{...row,fixtureBusy:true});return {fixtureBusy:true};}
   db.exec('BEGIN IMMEDIATE');
   try{db.prepare('INSERT INTO deliveries VALUES(?,?)').run(a.intent,a.hash);save(a.intent,{...row,state:'delivered'});db.exec('COMMIT');}
   catch(error){db.exec('ROLLBACK');throw error;}
   if(config.lostSinkResponseOnce)return {fixtureLostResponse:true};
  }
  await h('reconcile',{token:f.adapter,id:row.operation,...row.claim,providerRef:'local-sink:'+a.intent,usage:0});
  return {delivered:true};
 }
 throw Error('Unknown bridge route');
}
const server=createServer(async(req,res)=>{
 const key=Buffer.from(String(req.headers['x-remold-key']??'')),expected=Buffer.from(config.bridgeKey);
 if(key.length!==expected.length||!timingSafeEqual(key,expected)){res.writeHead(403);res.end('{}');return;}
 if(req.method!=='POST'){res.writeHead(405);res.end('{}');return;}
 if(inFlight){res.writeHead(503);res.end('{"busy":true}');return;}
 let body='';for await(const chunk of req){body+=chunk;if(body.length>65536){res.writeHead(413);res.end('{}');return;}}
 if(inFlight){res.writeHead(503);res.end('{"busy":true}');return;}
 inFlight=true;
 try{const value=await route(req.url,JSON.parse(body));if(value.fixtureLostResponse){res.destroy();return;}if(value.fixtureBusy){res.writeHead(503);res.end('{"busy":true}');return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));}
 catch{res.writeHead(409,{'Content-Type':'application/json'});res.end('{"refused":true}');}
 finally{inFlight=false;}
});
server.listen(3542,'0.0.0.0',()=>console.log('Synthetic marketing authority bridge ready; no external mail transport.'));
