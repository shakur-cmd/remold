import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,appendFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SendLedger } from './send-ledger.mjs';
const A='shakur@envoylogic.com',B='reply@repliedfor.com',C='shakur@codemyvibe.com';
const intent=(id,from=A,to=B)=>({id,from,to,contentHash:'a'.repeat(64)});
async function setup(t){const dir=await mkdtemp(join(tmpdir(),'p5-same-sender-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'ledger');const clock=()=>1790290000000;const ledger=new SendLedger(path,clock);await ledger.initialize();return{path,ledger,clock};}
test('A to B and newly approved C share the same five-attempt allowance across restart',async t=>{
 const {path,ledger,clock}=await setup(t);for(let i=0;i<3;i++)await ledger.reserve(intent('b'+i));
 const before=await readFile(path,'utf8');await ledger.reserve(intent('c0',A,C));await ledger.outcome('c0','unknown');
 const restarted=new SendLedger(path,clock);await restarted.reserve(intent('c1',A,C));
 for(const to of [B,C])await assert.rejects(restarted.reserve(intent('sixth'+to[0],A,to)),/SEND_CAP/);
 assert.ok((await readFile(path,'utf8')).startsWith(before),'Existing rows must remain byte-identical prefix');
 assert.equal((await restarted.reserve(intent('reply',B,A))).shouldDispatch,true);
 assert.equal((await restarted.reserve(intent('c0',A,C))).shouldDispatch,false);
});
test('C remains recipient-only and B cannot address C',async t=>{
 const {ledger}=await setup(t);for(const [from,to]of[[C,A],[C,B],[C,C],[B,C],[A,A],[A,'other@example.invalid']])await assert.rejects(ledger.reserve(intent('forbidden',from,to)),/ROUTE_NOT_ALLOWED|RECIPROCAL_ONLY/);
});
test('malformed new route, duplicate reservations and orphan outcomes still corrupt the ledger',async t=>{
 for(const bad of [{kind:'reservation',at:1790290000000,...intent('bad',C,A)},{kind:'outcome',at:1790290000000,id:'unknown',status:'accepted'},{kind:'reservation',at:1790290000000,...intent('existing')}]){
 const {path,ledger}=await setup(t);await ledger.reserve(intent('existing'));await appendFile(path,JSON.stringify(bad)+'\n');await assert.rejects(ledger.reserve(intent('next',A,C)),/LEDGER_CORRUPT/);
 }
});

import { makePlan,validatePlan,acceptedReference,capacity,validateRelease,runSequence } from './same-sender-core.mjs';
const plan=makePlan('11111111-1111-4111-8111-111111111111');
test('exact plan and release refuse extra recipients, lower timing and altered allowance',()=>{
 for(const changed of[{...plan,capPerRolling24h:6},{...plan,qGapMs:1},{...plan,observeMs:1},{...plan,messages:plan.messages.map(m=>m.name==='Q1'?{...m,to:B}:m)}])assert.throws(()=>validatePlan(changed));
 validateRelease({action:'root-reviewed-same-sender-send',planSha256:'abc'},'abc');
 assert.throws(()=>validateRelease({action:'root-reviewed-same-sender-send',planSha256:'other'},'abc'));
});
async function scenario(t,patch={}){
 const f=await setup(t);let time=f.clock();const ledger=new SendLedger(f.path,()=>time),sent=[],events=[];
 await ledger.reserve(intent('old-A'));for(let i=0;i<4;i++)await ledger.reserve(intent('old-B'+i,B,A));
 const metadataById=new Map();
 const options={plan,now:()=>time,wait:async ms=>{time+=ms;},record:async e=>events.push(e),
 dispatch:async(message,thread)=>{const reservationId=plan.run+'-'+message.name;assert.equal((await ledger.reserve({...intent(reservationId,message.from,message.to),contentHash:'b'.repeat(64)})).shouldDispatch,true);sent.push(message);await ledger.outcome(reservationId,'accepted');const receipt={name:message.name,reservationId,providerRef:message.name,thread:thread??'thread-'+message.name,acceptedAt:time};if(message.from===A)metadataById.set(message.name,{id:message.name,threadId:receipt.thread,payload:{headers:[{name:'From',value:A},{name:'To',value:message.to},{name:'Subject',value:message.subject},{name:'Message-ID',value:`<actual-${message.name}@mail.gmail.com>`}]}});return receipt;},
 metadata:async receipt=>metadataById.get(receipt.providerRef),observeP:async id=>assert.equal(id,'<actual-P1@mail.gmail.com>'),
 observeReply:async()=>({id:'reply-id',from:B,to:[A],thread:'thread-P1',inReplyTo:'<actual-P1@mail.gmail.com>'}),suppressP:async()=>{},pBlocked:async()=>true,...patch};
 return{...f,ledger,sent,events,options};
}
test('same sender reaches B and C, stripped reply stops P, Q spacing and observation stay bounded without spending P2/P3',async t=>{
 const f=await scenario(t);assert.deepEqual((await capacity(f.ledger,plan)).used,{[A]:1,[B]:4});
 const result=await runSequence(f.options);assert.equal(result.status,'SENT_REPLY_CUTOFF_C_RECEIPTS_PENDING');assert.equal(result.elapsedMs,540000);
 assert.deepEqual(f.sent.map(m=>[m.name,m.from,m.to]),[['P1',A,B],['Q1',A,C],['reply-P',B,A],['Q2',A,C],['Q3',A,C]]);
 assert.equal(f.sent[2].inReplyTo,'<actual-P1@mail.gmail.com>');assert.equal(f.sent[3].inReplyTo,'<actual-Q1@mail.gmail.com>');assert.equal(f.sent[4].inReplyTo,'<actual-Q1@mail.gmail.com>');
 const q=result.receipts.filter(r=>r.name.startsWith('Q'));assert.equal(q[1].acceptedAt-q[0].acceptedAt,120000);assert.equal(q[2].acceptedAt-q[1].acceptedAt,120000);
 const rows=(await readFile(f.path,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(rows.filter(r=>r.kind==='reservation'&&r.from===A).length,5);assert.equal(rows.filter(r=>r.kind==='reservation'&&r.from===B).length,5);assert.equal(rows.some(r=>r.id?.endsWith('-P2')||r.id?.endsWith('-P3')),false);
 for(const from of[A,B])await assert.rejects(f.ledger.reserve(intent('overflow'+from[0],from,from===A?C:A)),/SEND_CAP/);
});
test('wrong reply thread or missing cutoff stops the fixture before Q2/Q3',async t=>{
 for(const patch of[{observeReply:async()=>({id:'wrong',from:B,to:[A],thread:'thread-Q1',inReplyTo:'<actual-P1@mail.gmail.com>'})},{pBlocked:async()=>false}]){
 const f=await scenario(t,patch);await assert.rejects(runSequence(f.options));assert.deepEqual(f.sent.map(m=>m.name),['P1','Q1','reply-P']);
 }
});
test('metadata from wrong destination or unrelated accepted ID cannot become a reply reference',()=>{
 const message=plan.messages[1],receipt={providerRef:'known',thread:'Q'};
 const metadata={id:'known',threadId:'Q',payload:{headers:[{name:'From',value:A},{name:'To',value:C},{name:'Subject',value:message.subject},{name:'Message-ID',value:'<actual@mail.gmail.com>'}]}};
 assert.equal(acceptedReference(message,receipt,metadata),'<actual@mail.gmail.com>');
 assert.throws(()=>acceptedReference(message,receipt,{...metadata,id:'other'}));assert.throws(()=>acceptedReference({...message,to:B},receipt,metadata));
});
test('capacity preflight counts prior unknown reservations without writing or resetting the ledger',async t=>{
 const f=await scenario(t);await f.ledger.reserve(intent('uncertain',A,C));await f.ledger.outcome('uncertain','unknown');const before=await readFile(f.path,'utf8');await assert.rejects(capacity(f.ledger,plan),/INSUFFICIENT_SHARED_SEND_CAP/);assert.equal(await readFile(f.path,'utf8'),before);
});
test('provider thread drift after Q2 acceptance stops Q3 instead of pretending continuity',async t=>{
 const f=await scenario(t),send=f.options.dispatch;
 f.options.dispatch=async(...args)=>{const r=await send(...args);return r.name==='Q2'?{...r,thread:'different-provider-thread'}:r;};
 await assert.rejects(runSequence(f.options),/verified Q thread/);assert.deepEqual(f.sent.map(m=>m.name),['P1','Q1','reply-P','Q2']);
});
