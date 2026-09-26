import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {credentials,provider} from '../../../../proofs/payments/stripe.mjs';

const source=new URL('../../../../proofs/payments/evidence/sandbox.json',import.meta.url);
const originalBytes=readFileSync(source),original=JSON.parse(originalBytes);
const runId='3f7c6229-f345-4b59-8b6a-971208c4efe7';
const expected=[
 {kind:'customer',account:'acct_1UJIndJL8hhTtG1o',id:'cus_VJzrZTORGay5Lp'},
 {kind:'customer',account:'acct_1UJL2DR59Pk6MTFE',id:'cus_VJzr8q1ZtrR81v'},
];
assert.equal(original.runId,runId);assert.deepEqual(original.objects,expected);
const stripe=provider(credentials()),guard=await stripe.verify(),rows=[];
// This checkpoint has no mutation method, local backend or financial replay.
const get=(path,params,account)=>stripe.request('GET',path,params,account);
for(const row of expected){
 const customer=await get('/v1/customers/'+row.id,{},row.account);
 assert.equal(customer.id,row.id);assert.equal(customer.livemode,false);
 assert.equal(customer.metadata?.remold_fixture,runId);assert.equal(customer.email,null);
 const counts={};
 for(const name of ['invoices','payment_intents','charges']){
  const list=await get('/v1/'+name,{customer:row.id,limit:100},row.account);
  assert.equal(list.object,'list');assert.equal(list.has_more,false);
  assert.ok(Array.isArray(list.data));assert.equal(list.data.length,0);
  counts[name]={count:0,complete:true,customerFilter:row.id};
 }
 rows.push({account:row.account,customer:row.id,testMode:true,originalFixtureMatches:true,emailAbsent:true,lists:counts});
}
assert.ok(stripe.receipts.every(r=>r.method==='GET'&&r.httpStatus===200));
const result={status:'PASS exact read-only first-run checkpoint',reviewer:'c0_verifier',at:new Date().toISOString(),level:'SANDBOX actual Stripe GET responses',runId,originalEvidenceSha256:createHash('sha256').update(originalBytes).digest('hex'),guard,rows,receipts:stripe.receipts,limits:'Only these two exact customer scopes checked. No writes, no resumed lifecycle, no local backend; whole P4 remains incomplete.'};
writeFileSync(new URL('./provider-first-run.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:result.status,customers:rows.length,getRequests:stripe.receipts.length,financialObjects:0}));
