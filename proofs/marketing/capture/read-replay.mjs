import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {directory} from '../runtime.mjs';
import {upperSubmissionId,readSubmissionPage,readEmailSuppression} from './native.mjs';
const rows=[];
for(const tenant of ['a','b']){
 const upper=upperSubmissionId(tenant,1),items=[],pages=[];let after=0;
 for(let n=0;n<128;n++){
  const page=readSubmissionPage(tenant,1,{after,upper,limit:1});assert.deepEqual(readSubmissionPage(tenant,1,{after,upper,limit:1}),page,'Same bounded native page re-read must be stable');
  items.push(...page.items);pages.push({after,next:page.next,complete:page.complete,ids:page.items.map(s=>s.submissionId)});after=page.next;if(page.complete)break;if(n===127)throw Error('Bounded traversal exceeded proof cap');
 }
 assert.equal(after,upper);assert.equal(new Set(items.map(s=>s.submissionId)).size,items.length);
 const empty=readSubmissionPage(tenant,1,{after:upper,upper,limit:1});assert.deepEqual(empty.items,[]);assert.equal(empty.complete,true);
 const suppressed=items.filter(s=>s.contactId!==null).map(s=>readEmailSuppression(tenant,s.contactId));
 rows.push({tenant,upper,pages,items,suppressed});
}
assert.ok(rows.every(r=>r.items.length>0));assert.equal(rows[0].items[0].submissionId,rows[1].items[0].submissionId);assert.notEqual(rows[0].items[0].sha256,rows[1].items[0].sha256);
writeFileSync(directory+'capture/evidence/read-replay.json',JSON.stringify({capturedAt:new Date().toISOString(),status:'PASS',level:'SERVICE native read-only pagination and current suppression lookup; no durable import/callback proof',rows,limits:['No callbacks configured','No checkpoint persistence or Convex import yet','No concurrent delete/append or consent flip exercised','DNC absence does not establish marketing opt-in']},null,2)+'\n');
console.log('PASS bounded ID pages re-read stably across A/B; qualified sort/filter works; current native suppression lookup succeeds.');
