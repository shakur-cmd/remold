import assert from'node:assert/strict';
import{randomUUID,createHash}from'node:crypto';
import{writeFileSync}from'node:fs';
import{ConvexHttpClient}from'convex/browser';
import{api}from'./convex/_generated/api.js';
import{withPayments}from'./local.mjs';
const results=[];
await withPayments(async({run,url})=>{
 const client=new ConvexHttpClient(url,{logger:false}),f=run('harness:seed',{run:randomUUID(),tokens:Array.from({length:10},()=>randomUUID())});
 const m=(name,args)=>client.mutation(api.payments[name],args),q=(name,args)=>client.query(api.payments[name],args),a=(name,args)=>client.action(api.payments[name],args);
 const concurrent=(name,args)=>new ConvexHttpClient(url,{logger:false}).mutation(api.payments[name],args);
 const check=async(name,fn)=>{await fn();results.push({name,status:'PASS'});console.log('PASS '+name)};
 const owner=f.A.sessions.owner;
 const customer=run('paymentFixture:customer',{org:f.A.org,binding:f.A.binding,name:'SyntheticA'});
 const customerB=run('paymentFixture:customer',{org:f.B.org,binding:f.B.binding,name:'SyntheticB'});
 const bBefore=await q('exportFinance',{token:f.B.sessions.owner});
 const quote=await m('createQuote',{token:owner,customer,amountMinor:10001,currency:'usd'});
 await check('Human creates integer-minor quote in own workspace',async()=>assert.ok(quote));
 await check('Cross-tenant customer/account IDs and actor injection cannot create obligations',async()=>{
  await assert.rejects(m('createQuote',{token:owner,customer:customerB,amountMinor:100,currency:'usd'}),/tenant denied/);
  await assert.rejects(m('createQuote',{token:f.A.sessions.restricted,customer,amountMinor:100,currency:'usd'}),/human finance authority/);
  await assert.rejects(m('createQuote',{token:owner,customer,amountMinor:100,currency:'usd',account:f.B.key.account}),/extra field/);
  await assert.rejects(m('createQuote',{token:owner,customer,amountMinor:1.5,currency:'usd'}),/integer minor units/);
 });
 const link1=await a('issueAcceptance',{token:owner,id:quote,expires:Date.now()+60000});
 await m('reviseQuote',{token:owner,id:quote,amountMinor:10003});
 const link=await a('issueAcceptance',{token:owner,id:quote,expires:Date.now()+60000});
 await check('Acceptance is bound to immutable version and secret, with duplicate clicks atomic',async()=>{
  await assert.rejects(m('acceptQuote',{id:quote,...link1}),/invalid or expired/);
  await assert.rejects(m('acceptQuote',{id:quote,version:link.version,token:link.token+'tamper'}),/invalid or expired/);
  const clicks=await Promise.all([1,2].map(()=>concurrent('acceptQuote',{id:quote,...link})));assert.deepEqual(clicks,[quote,quote]);
  await assert.rejects(m('reviseQuote',{token:owner,id:quote,amountMinor:1}),/immutable/);
 });
 const other=await m('createQuote',{token:owner,customer,amountMinor:500,currency:'usd'});
 const expired=await a('issueAcceptance',{token:owner,id:other,expires:Date.now()+1000});await new Promise(r=>setTimeout(r,1100));
 await check('Expired public acceptance is refused',async()=>assert.rejects(m('acceptQuote',{id:other,...expired}),/invalid or expired/));
 const deposits=await Promise.all([1,2].map(()=>concurrent('prepareDeposit',{token:owner,quote,amountMinor:3001,currency:'usd'})));
 const deposit=deposits[0];
 await check('Deposit intent is created once; currency and amount changes are refused',async()=>{
  assert.equal(deposits[0],deposits[1]);
  await assert.rejects(m('prepareDeposit',{token:owner,quote,amountMinor:3001,currency:'eur'}),/invalid deposit/);
  await assert.rejects(m('prepareDeposit',{token:owner,quote,amountMinor:3002,currency:'usd'}),/already exists/);
  await assert.rejects(m('prepareBalance',{token:owner,quote}),/paid unallocated/);
 });
 await m('attachProvider',{token:f.A.adapter,id:deposit,externalId:'in_synthetic_deposit'});
 const observation={token:f.A.adapter,binding:f.A.binding,externalId:'in_synthetic_deposit',eventId:'evt_synthetic_paid',digest:createHash('sha256').update('synthetic authoritative fixture').digest('hex'),state:'paid',paidMinor:3001,refundedMinor:0,currency:'usd'};
 await check('Browser paid forgery and wrong-account adapter cannot settle an invoice',async()=>{
  await assert.rejects(m('observe',{...observation,token:owner}),/adapter account denied/);
  await assert.rejects(m('observe',{...observation,token:f.B.adapter}),/adapter account denied/);
  assert.equal((await q('getDocument',{token:owner,id:deposit})).paidMinor,0);
  await assert.rejects(q('getDocument',{token:f.A.sessions.restricted,id:deposit}),/human finance authority/);
  await assert.rejects(q('getDocument',{token:f.B.sessions.owner,id:deposit}),/tenant denied/);
 });
 await check('Authenticated replay settles once and changed callback bytes are refused',async()=>{
  assert.equal(await m('observe',observation),true);assert.equal(await m('observe',observation),false);
  await assert.rejects(m('observe',{...observation,digest:'different'}),/integrity mismatch/);
 });
 const balances=await Promise.all([1,2].map(()=>concurrent('prepareBalance',{token:owner,quote})));const balance=balances[0];
 await check('Deposit allocation is once-only and exact integer arithmetic preserves total',async()=>{
  assert.equal(balances[0],balances[1]);const d=await q('getDocument',{token:owner,id:deposit}),b=await q('getDocument',{token:owner,id:balance});
  assert.equal(d.allocatedTo,balance);assert.equal(b.depositAllocation,deposit);assert.equal(b.amountMinor,7002);assert.equal(BigInt(d.amountMinor)+BigInt(b.amountMinor),10003n);
 });
 await check('Concurrent financial commands emit one attributed event per obligation',async()=>{const events=run('paymentFixture:counts',{org:f.A.org}).events;for(const [kind,resource]of [['quote.accepted',quote],['deposit.prepared',deposit],['balance.allocated',balance]])assert.equal(events.filter(e=>e.kind===kind&&e.resource===resource).length,1);assert.ok(events.some(e=>e.kind==='deposit.prepared'&&e.actor===f.A.actors.owner));});
 const beforeReadonly=await q('getDocument',{token:owner,id:deposit});
 await client.mutation(api.harness.control,{token:owner,readonly:true});
 await check('Readonly refuses new issuance but incoming reconciliation and export continue',async()=>{
  await assert.rejects(m('createQuote',{token:owner,customer,amountMinor:100,currency:'usd'}),/readonly/);
  assert.equal(await m('observe',{...observation,eventId:'evt_synthetic_refund',digest:'refund',refundedMinor:101}),true);
  assert.ok((await q('exportFinance',{token:owner})).documents.length>=2);
 });
 await m('removeCustomer',{token:owner,id:customer});
 await check('Removing customer preserves issued snapshot and retained financial attribution',async()=>{
  const after=await q('getDocument',{token:owner,id:deposit});assert.equal(after.customerName,'SyntheticA');assert.equal(after.snapshotHash,beforeReadonly.snapshotHash);assert.equal(after.amountMinor,beforeReadonly.amountMinor);assert.ok(after.retentionUntil>Date.now());
 });
 await client.mutation(api.harness.control,{token:owner,readonly:false,healthy:false,binding:f.A.binding});
 await check('Restricted/disconnected merchant refuses new issuance while history remains',async()=>{
  await assert.rejects(m('createQuote',{token:owner,customer,amountMinor:100,currency:'usd'}),/merchant restricted/);
  assert.equal((await q('getDocument',{token:owner,id:deposit})).paidMinor,3001);
 });
 assert.deepEqual(await q('exportFinance',{token:f.B.sessions.owner}),bBefore);
 await check('Tenant B canonical finance export stays unchanged',async()=>assert.deepEqual(await q('exportFinance',{token:f.B.sessions.owner}),bBefore));
});
writeFileSync(new URL('./evidence/domain.json',import.meta.url),JSON.stringify({level:'SERVICE local Convex; SIM identity/provider observations',results,limitations:['Provider observations in this suite are synthetic and do not certify Stripe settlement.','One-year retained synthetic document policy requires commercial confirmation.','Frozen H0 general refund refusal remains intentional; additive safety is separately tested and pending production/IV/G-pay.']},null,2)+'\n');
console.log(JSON.stringify({passed:results.length}));
