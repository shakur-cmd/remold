import assert from 'node:assert/strict';
import { matchReply } from './adapter.mjs';
export const A='shakur@envoylogic.com', B='reply@repliedfor.com', C='shakur@codemyvibe.com';
export function makePlan(run){
 assert.match(run,/^[a-f0-9-]{36}$/);
 const message=(name,from,to,group,reference)=>({name,from,to,subject:(name==='reply-P'?'Re: ':'')+`Remold P5 test ${run} ${group}`,messageId:`<remold-p5-${run}-${name}@repliedfor.com>`,text:name==='reply-P'?'Yes, stop this controlled test sequence.':`Remold controlled integration test ${run}, ${name}. No customer outreach.`,...(reference?{reference}:{} )});
 return{version:1,run,senders:[A,B],recipientOnly:C,capPerRolling24h:5,plannedCounts:{[A]:4,[B]:1},qGapMs:120000,observeMs:540000,messages:[message('P1',A,B,'P'),message('Q1',A,C,'Q'),message('reply-P',B,A,'P','P1'),message('Q2',A,C,'Q','Q1'),message('Q3',A,C,'Q','Q1')],calendarCalls:0};
}
export function validatePlan(plan){assert.deepEqual(plan,makePlan(plan.run),'Exact approved fixture shape required');}
export function acceptedReference(message,receipt,metadata){
 assert.equal(message.from,A);assert.equal(metadata.id,receipt.providerRef);assert.equal(metadata.threadId,receipt.thread);
 const headers=Object.fromEntries(metadata.payload.headers.map(h=>[h.name.toLowerCase(),h.value]));
 assert.equal(headers.from,A);assert.equal(headers.to,message.to);assert.equal(headers.subject,message.subject);
 assert.match(headers['message-id'],/^<[A-Za-z0-9_=+./-]+@mail\.gmail\.com>$/);
 return headers['message-id'];
}
export async function capacity(ledger,plan){
 validatePlan(plan);return ledger.transaction((rows,at)=>{
 const used=Object.fromEntries([A,B].map(a=>[a,rows.filter(r=>r.kind==='reservation'&&r.from===a&&r.at>at-86400000).length]));
 for(const a of[A,B])assert.ok(used[a]+plan.plannedCounts[a]<=5,'INSUFFICIENT_SHARED_SEND_CAP');
 return{result:{at,used,planned:plan.plannedCounts}};
 });
}
export function validateRelease(release,planHash){assert.deepEqual(release,{action:'root-reviewed-same-sender-send',planSha256:planHash},'Root release must match exact reviewed plan');}
export async function runSequence({plan,dispatch,metadata,observeP,observeReply,suppressP,pBlocked,record,now,wait}){
 validatePlan(plan);const start=now(),receipts=[],refs=new Map();
 async function send(template){
  const {reference,...message}=template;
  if(reference){assert.ok(refs.has(reference));message.inReplyTo=refs.get(reference).messageId;}
  const receipt=await dispatch(message,reference?refs.get(reference).thread:undefined);
  assert.equal(receipt.name,message.name);if(message.from===A&&reference)assert.equal(receipt.thread,refs.get(reference).thread,'Follow-up must keep the verified Q thread');assert.ok(Number.isSafeInteger(receipt.acceptedAt)&&receipt.acceptedAt>=start);
  receipts.push(receipt);await record({kind:'accepted',message,receipt});
  if(message.from===A){const messageId=acceptedReference(message,receipt,await metadata(receipt));refs.set(message.name,{messageId,thread:receipt.thread});receipt.actualMessageId=messageId;await record({kind:'verified-reference',name:message.name,messageId,providerRef:receipt.providerRef,thread:receipt.thread});}
  return receipt;
 }
 const[P1,Q1,reply,Q2,Q3]=plan.messages;
 await send(P1);let lastQ=await send(Q1);
 await observeP(refs.get('P1').messageId);
 const replyReceipt=await send(reply),incoming=await observeReply(replyReceipt,refs.get('P1').messageId,lastQ.acceptedAt+115000);
 const context={org:'fixture',binding:'P',account:'verified-A',mailbox:A,contact:B,thread:refs.get('P1').thread,messageId:refs.get('P1').messageId,sequence:'P',replyOwner:'personal-sales'};
 const observed={...incoming,org:'fixture',binding:'P',account:'verified-A',mailbox:A};
 assert.equal(matchReply([context],observed)?.sequence,'P','Verified stripped reply must match P');
 assert.equal(matchReply([{...context,contact:C,thread:refs.get('Q1').thread,messageId:refs.get('Q1').messageId,sequence:'Q'}],observed),null);
 await suppressP(incoming.id);await record({kind:'reply-matched',providerRef:incoming.id,at:now()});
 const cutoff=[];
 for(const [i,next]of[Q2,Q3].entries()){
  await wait(Math.max(0,lastQ.acceptedAt+plan.qGapMs-now()));
  assert.equal(await pBlocked('P'+(i+2)),true,'P follow-up must be blocked before any ledger reservation');
  cutoff.push({name:'P'+(i+2),at:now(),denied:true});
  const receipt=await send(next);assert.ok(receipt.acceptedAt-lastQ.acceptedAt>=plan.qGapMs);lastQ=receipt;
 }
 await wait(Math.max(0,start+plan.observeMs-now()));
 const result={status:'SENT_REPLY_CUTOFF_C_RECEIPTS_PENDING',elapsedMs:now()-start,receipts,cutoff,counts:plan.plannedCounts,cReceiptRequests:receipts.filter(r=>r.name.startsWith('Q')).map(r=>({name:r.name,messageId:r.actualMessageId,from:A,to:C,reservationId:r.reservationId})),calendarCalls:0};
 assert.ok(result.elapsedMs>=540000);await record({kind:'sequence-complete',result});return result;
}
