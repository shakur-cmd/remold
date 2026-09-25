import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SendLedger} from '../../../proofs/communications/send-ledger.mjs';
import {SendLedger as OldLedger} from '../../../proofs/communications/.private/before-same-sender/send-ledger.mjs';
import {A,B,C,makePlan,runSequence} from '../../../proofs/communications/same-sender-core.mjs';
const plan=makePlan('22222222-2222-4222-8222-222222222222'),results=[];
const intent=(id,from=A,to=B)=>({id,from,to,contentHash:'c'.repeat(64)});
const root=await mkdtemp(join(tmpdir(),'remold-same-sender-iv-'));
try{
 const old=new OldLedger(join(root,'old'));await old.initialize();await assert.rejects(old.reserve(intent('new-route',A,C)),/RECIPROCAL_ONLY/);results.push('Archived old route independently refuses A-to-C');
 for(const mode of ['wrong-sender','wrong-reference','q2-unknown']){
  let now=1790290000000;const path=join(root,mode),ledger=new SendLedger(path,()=>now);await ledger.initialize();await ledger.reserve(intent('prior-a'));for(let i=0;i<4;i++)await ledger.reserve(intent('prior-b'+i,B,A));
  const sent=[],cutoffs=[],metadata=new Map();let suppressed=false;
  const options={plan,now:()=>now,wait:async ms=>{now+=ms;},record:async()=>{},
   dispatch:async(message,thread)=>{const id=plan.run+'-'+message.name;assert.equal((await ledger.reserve(intent(id,message.from,message.to))).shouldDispatch,true);sent.push(message.name);
    if(mode==='q2-unknown'&&message.name==='Q2'){await ledger.outcome(id,'unknown');throw Error('SYNTHETIC_RESPONSE_UNKNOWN');}
    now+=1700;await ledger.outcome(id,'accepted');const receipt={name:message.name,reservationId:id,providerRef:message.name,thread:thread??'iv-thread-'+message.name,acceptedAt:now};metadata.set(message.name,{id:message.name,threadId:receipt.thread,payload:{headers:[{name:'From',value:message.from},{name:'To',value:message.to},{name:'Subject',value:message.subject},{name:'Message-ID',value:'<iv-'+message.name+'@mail.gmail.com>'}]}});return receipt;},
   metadata:async r=>metadata.get(r.providerRef),observeP:async()=>{},
   observeReply:async()=>({id:'reply',from:mode==='wrong-sender'?C:B,to:[A],thread:'iv-thread-P1',inReplyTo:mode==='wrong-reference'?'<iv-Q1@mail.gmail.com>':'<iv-P1@mail.gmail.com>'}),
   suppressP:async()=>{suppressed=true;},pBlocked:async name=>{cutoffs.push(name);return true;}};
  await assert.rejects(runSequence(options),mode==='q2-unknown'?/SYNTHETIC_RESPONSE_UNKNOWN/:/Verified stripped reply/);
  const rows=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse),reservations=rows.filter(r=>r.kind==='reservation');
  if(mode==='q2-unknown'){
   assert.deepEqual(sent,['P1','Q1','reply-P','Q2']);assert.deepEqual(cutoffs,['P2']);assert.equal(suppressed,true);
   const restarted=new SendLedger(path,()=>now);assert.equal((await restarted.reserve(intent(plan.run+'-Q2',A,C))).shouldDispatch,false);assert.equal(rows.at(-1).status,'unknown');
   assert.equal(reservations.filter(r=>r.from===A).length,4);assert.equal(reservations.filter(r=>r.from===B).length,5);
  }else{assert.deepEqual(sent,['P1','Q1','reply-P']);assert.equal(suppressed,false);assert.deepEqual(cutoffs,[]);assert.equal(reservations.filter(r=>r.from===A).length,3);}
  assert.equal(reservations.some(r=>r.id.endsWith('-P2')||r.id.endsWith('-P3')||r.id.endsWith('-Q3')),false);
  results.push({mode,sent,cutoffs,suppressed,providerCalls:0,counts:{A:reservations.filter(r=>r.from===A).length,B:reservations.filter(r=>r.from===B).length}});
 }
 const path=join(root,'compatibility');let time=1790290000000;const newLedger=new SendLedger(path,()=>time);await newLedger.initialize();await newLedger.reserve(intent('approved-c',A,C));time+=2*86400000;
 await assert.rejects(new OldLedger(path,()=>time).reserve(intent('legacy-next')),/LEDGER_CORRUPT/);assert.equal((await new SendLedger(path,()=>time).reserve(intent('new-next',A,C))).shouldDispatch,true);results.push('Archived parser still fails closed after24h; successor parses shared history without reset');
 await writeFile(new URL('./altered.json',import.meta.url),JSON.stringify({status:'PASS',level:'SIM sequence/provider responses; real temporary durable ledger, no provider calls',results},null,2)+'\n');console.log(JSON.stringify({status:'PASS',groups:results.length}));
}finally{await rm(root,{recursive:true,force:true});}
