import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {ConvexHttpClient} from 'convex/browser';
import {api} from './convex/_generated/api.js';
import {withPayments} from './local.mjs';
const results=[];
await withPayments(async({url,run})=>{
 const client=new ConvexHttpClient(url,{logger:false}), f=run('harness:seed',{run:randomUUID(),tokens:Array.from({length:10},()=>randomUUID())});
 const m=(name,args)=>client.mutation(api.payments[name],args),q=(name,args)=>client.query(api.payments[name],args);
 const check=async(name,fn)=>{await fn();results.push({name,status:'PASS'});console.log('PASS '+name)};
 const owner=f.A.sessions.owner,customer=run('paymentFixture:customer',{org:f.A.org,binding:f.A.binding,name:'Safety synthetic'});
 const quote=await m('createQuote',{token:owner,customer,amountMinor:1000,currency:'usd'});
 const link=await client.action(api.payments.issueAcceptance,{token:owner,id:quote,expires:Date.now()+60000});await m('acceptQuote',{id:quote,...link});
 const doc=await m('prepareDeposit',{token:owner,quote,amountMinor:1000,currency:'usd'});
 await m('attachProvider',{token:f.A.adapter,id:doc,externalId:'in_synthetic_safety'});
 await m('observe',{token:f.A.adapter,binding:f.A.binding,externalId:'in_synthetic_safety',eventId:'synthetic_paid',digest:'synthetic',state:'paid',paidMinor:1000,refundedMinor:0,currency:'usd'});
 const epoch=await m('reconcileAdjustments',{token:f.A.adapter,binding:f.A.binding,externalId:'in_synthetic_safety',complete:false,refundedMinor:0,creditedMinor:0,receipts:[]});await m('reconcileAdjustments',{token:f.A.adapter,binding:f.A.binding,externalId:'in_synthetic_safety',complete:true,epoch,refundedMinor:0,creditedMinor:0,receipts:[{kind:'payment',receiptId:'inpay_synthetic',sourceRef:'pi_synthetic',amountMinor:1000,status:'succeeded'}]});
 // Before the safety path exists, this valid request fails at the missing behavior seam.
 const args={token:owner,document:doc,binding:f.A.binding,destination:f.A.key.account,action:'refund',amountMinor:600,logical:randomUUID()};
 await assert.rejects(m('prepareSafety',args),/current finance membership/);
 run('paymentFixture:role',{actor:f.A.actors.owner,role:'finance'});
 await m('bindSafetyReference',{token:f.A.adapter,id:doc,paymentIntent:'pi_synthetic_safety',charge:'ch_synthetic_safety',subscription:'sub_synthetic_safety'});
 const op=await m('prepareSafety',args);
 run('paymentFixture:role',{actor:f.A.actors.owner,role:'viewer'});
 await check('Current role is checked again at final permit',()=>assert.rejects(m('permitSafety',{token:f.A.adapter,id:op}),/current finance membership/));
 run('paymentFixture:role',{actor:f.A.actors.owner,role:'finance'});
 await client.mutation(api.harness.control,{token:owner,readonly:true});
 let permit;
 await check('Readonly permits one bounded human refund and records its actor',async()=>{permit=await m('permitSafety',{token:f.A.adapter,id:op});assert.equal(permit.amountMinor,600);assert.equal(permit.account,f.A.key.account);assert.equal(permit.paymentIntent,'pi_synthetic_safety');assert.equal(permit.key,op+':step:1');const audit=run('paymentFixture:counts',{org:f.A.org}).events;assert.ok(audit.some(e=>e.actor===f.A.actors.owner&&e.kind==='readonly.safety.permit.refund'&&e.resource===op));await assert.rejects(m('permitSafety',{token:f.A.adapter,id:op}),/already dispatched/);});
 await check('In-flight reservations prevent concurrent over-refunds',async()=>{const pending=await Promise.all([1,2].map(()=>m('prepareSafety',{...args,amountMinor:300,logical:randomUUID()})));const outcomes=await Promise.allSettled(pending.map(id=>new ConvexHttpClient(url,{logger:false}).mutation(api.payments.permitSafety,{token:f.A.adapter,id})));assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.match(outcomes.find(x=>x.status==='rejected').reason.message,/remaining paid/);});
 await client.mutation(api.harness.grant,{token:owner,target:f.A.actors.manager,capability:'billing.refund',scope:{kind:'bindings',bindings:[f.A.binding],maxAmountMinor:1000,currency:'usd',maxRecipients:1},mode:'direct',delegate:false,expires:Date.now()+60000});
 await check('Tenant, account, binding and agent authority cannot enter the safety path',async()=>{
  await assert.rejects(m('prepareSafety',{...args,token:f.B.sessions.owner}),/tenant denied/);
  await assert.rejects(m('prepareSafety',{...args,destination:f.B.key.account}),/account mismatch/);
  await assert.rejects(m('prepareSafety',{...args,binding:f.B.binding}),/account mismatch/);
  await assert.rejects(m('prepareSafety',{...args,token:f.A.sessions.manager}),/human finance authority/);
  for(const action of ['collect','retry','reactivate','price'])await assert.rejects(m('prepareSafety',{...args,action}),/ArgumentValidationError|validator/);
 });
 await check('Incoming truth settles a late refund after removal without granting new authority',async()=>{
  run('paymentFixture:role',{actor:f.A.actors.owner,role:'removed'});
  await m('observe',{token:f.A.adapter,binding:f.A.binding,externalId:'in_synthetic_safety',eventId:'synthetic_refund',digest:'synthetic-refund',state:'paid',paidMinor:1000,refundedMinor:600,currency:'usd'});
  const finish=await m('settleSafety',{token:f.A.adapter,id:op,providerRef:'re_synthetic_safety',receipt:{kind:'refund',receiptId:'re_synthetic_safety',sourceRef:'ch_synthetic_safety',operationId:op,amountMinor:600,status:'succeeded'}});assert.equal(finish.late,true);
  assert.equal((await m('settleSafety',{token:f.A.adapter,id:op,providerRef:'re_synthetic_safety'})).duplicate,true);
  await assert.rejects(m('prepareSafety',{...args,logical:randomUUID()}),/current finance membership/);
 });
 run('paymentFixture:role',{actor:f.A.actors.owner,role:'admin'});
 await check('Cancellation is a zero-value client lifecycle operation; disconnected bindings fail',async()=>{
  const id=await m('prepareSafety',{...args,action:'cancel',amountMinor:0,logical:randomUUID()});
  await client.mutation(api.harness.control,{token:owner,healthy:false,binding:f.A.binding});
  await assert.rejects(m('permitSafety',{token:f.A.adapter,id}),/merchant restricted/);
  await client.mutation(api.harness.control,{token:owner,healthy:true,binding:f.A.binding});
  const value=await m('permitSafety',{token:f.A.adapter,id});assert.equal(value.subscription,'sub_synthetic_safety');assert.equal(value.amountMinor,0);
  await assert.rejects(m('prepareSafety',{...args,action:'cancel',amountMinor:1,logical:randomUUID()}),/invalid safety amount/);
 });
 assert.ok((await q('exportFinance',{token:owner})).documents.length);
});
writeFileSync(new URL('./evidence/safety.json',import.meta.url),JSON.stringify({level:'SERVICE local Convex, SIM provider and identity; additive design proof only',results,pending:['Actual sandbox sends','I1 production integration and independent verification','G-pay owner commercial rule confirmation']},null,2)+'\n');
