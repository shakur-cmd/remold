import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {docker,prefix} from '../runtime.mjs';
import {api} from '../tenants/api.mjs';
import {nativeCounts} from '../publishing/read-effects-replay.mjs';
import {receipts,submit} from './callback-fixture.mjs';
import {upperSubmissionId,readSubmissionPage,readEmailSuppression} from './native.mjs';
export async function exerciseOutage({call,snap,bindings,keys,start,stop,results}){
 const auth={instance:bindings.a,key:keys.a},receiver=prefix+'-callback-a',before=await snap('a'),otherBefore=await snap('b'),nativeBefore={a:nativeCounts('a'),b:nativeCounts('b')},receiptBefore=receipts('a');
 async function finish(scan){const state=await snap('a'),ids=[...new Set([...state.captures.map(c=>c.data.contactId),...state.pending.items.map(c=>c.contactId)].filter(c=>c!==null))];return call('finish',{...auth,scan,observations:ids.map(c=>readEmailSuppression('a',c))});}
 async function poll(){const state=await snap('a'),upper=upperSubmissionId('a',1,state.cursor),scan='outage-'+randomUUID();let after=state.cursor;for(let n=0;n<100;n++){const p=readSubmissionPage('a',1,{after,upper,limit:1});await call('page',{...auth,scan,...p});after=p.next;if(p.complete)return finish(scan);}throw Error('OUTAGE_PAGE_CAP');}
 docker(['stop',receiver]);let restarted=false;
 try{
  const lost=[submit('a'),submit('a')];for(const s of lost)assert.equal(s.status,200,'Native acknowledges captures even while callback receiver is stopped');
  const upper=upperSubmissionId('a',1,before.cursor),scan='partial-'+randomUUID(),page=readSubmissionPage('a',1,{after:before.cursor,upper,limit:1});assert.equal(page.complete,false);
  await call('page',{...auth,scan,...page});const staged=await snap('a');assert.equal(staged.cursor,before.cursor);assert.deepEqual(staged.captures,before.captures);
  await stop('SIGKILL');
  const prior=readEmailSuppression('a',lost[0].contactId);assert.equal(prior.suppressed,false);
  const dnc=api('a','/contacts/'+lost[0].contactId+'/dnc/email/add','POST',{reason:3,comments:'Isolated capture recovery proof'});assert.equal(dnc.status,200);assert.equal(readEmailSuppression('a',lost[0].contactId).suppressed,true);
  const appended=submit('a');assert.equal(appended.status,200);assert.ok(upperSubmissionId('a',1)>upper);
  await start();assert.deepEqual(await snap('a'),staged);
  const remaining=readSubmissionPage('a',1,{after:page.next,upper,limit:1});assert.equal(remaining.complete,true);await call('page',{...auth,scan,...remaining});const completed=await finish(scan);assert.equal(completed.added,2);
  const afterFirst=await snap('a');assert.equal(afterFirst.cursor,upper);assert.equal(afterFirst.captures.some(c=>c.data.contactId===appended.contactId),false);assert.equal(afterFirst.suppression.find(c=>c.data.contactId===lost[0].contactId).data.suppressed,true);
  const recoveredAppend=await poll();assert.equal(recoveredAppend.added,1);const recovered=await snap('a');assert.equal(recovered.captures.length,before.captures.length+3);assert.deepEqual(await snap('b'),otherBefore);
  docker(['start',receiver]);restarted=true;assert.deepEqual(receipts('a'),receiptBefore,'Unavailable callbacks did not manufacture a receiver receipt; original receipt survived restart');
  const live=submit('a');assert.equal(live.status,200);const delivered=receipts('a');assert.ok(delivered.some(r=>r.body.includes(live.email)),'Native delivery resumes after receiver restart');
  const finalPoll=await poll();assert.equal(finalPoll.added,1);const final=await snap('a');assert.equal(final.captures.length,before.captures.length+4);assert.equal(final.suppression.find(c=>c.data.contactId===lost[0].contactId).data.suppressed,true);
  assert.deepEqual(nativeCounts('b'),nativeBefore.b);const nativeAfter=nativeCounts('a');assert.equal(nativeAfter.submissions,nativeBefore.a.submissions+4);assert.equal(nativeAfter.queuedEmails,nativeBefore.a.queuedEmails);assert.equal(nativeAfter.emailStats,nativeBefore.a.emailStats);
  results.push({name:'Actual callback outage, partial backend kill, current suppression and post-upper append recover without losing or duplicating captures',nativeBefore,nativeAfter,lost,appended,live,completed,recoveredAppend,finalPoll,receiptCounts:{before:receiptBefore.length,after:delivered.length},suppressedContact:lost[0].contactId,finalSnapshot:final,otherTenantUnchanged:true});
 }finally{if(!restarted)docker(['start',receiver]);}
}
