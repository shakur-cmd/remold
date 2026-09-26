import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {ConvexHttpClient} from 'convex/browser';
import {api} from './convex/_generated/api.js';
import {withPayments} from './local.mjs';
import {trustedAdapter} from './adapter.mjs';
const results=[];
await withPayments(async({url,run})=>{
 const c=new ConvexHttpClient(url,{logger:false});
 const f=run('harness:seed',{run:randomUUID(),tokens:Array.from({length:10},()=>randomUUID())});
 const m=(name,args)=>c.mutation(api.payments[name],args), owner=f.A.sessions.owner, adapter=f.A.adapter;
 run('paymentFixture:role',{actor:f.A.actors.owner,role:'finance'});
 const customer=run('paymentFixture:customer',{org:f.A.org,binding:f.A.binding,name:'Accounting synthetic'});
 const receipt=(kind,receiptId,amountMinor,status='succeeded',operationId)=>({kind,receiptId,amountMinor,status,...(operationId?{operationId}:{})});
 const normalized=(d,r)=>({...r,sourceRef:r.sourceRef??(r.kind==='refund'?'ch_'+d.id:d.externalId)});
 const args=(d,receipts=[])=>({token:adapter,binding:f.A.binding,externalId:d.externalId,receipts:[...(d.paymentReceipts??[]),...receipts.map(r=>normalized(d,r))],refundedMinor:receipts.filter(r=>r.kind==='refund'&&r.status==='succeeded').reduce((n,r)=>n+r.amountMinor,0),creditedMinor:receipts.filter(r=>r.kind==='credit'&&r.status==='succeeded').reduce((n,r)=>n+r.amountMinor,0)});
 const begin=d=>m('reconcileAdjustments',{...args(d),complete:false});
 const reconcile=async(d,receipts=[],complete=true)=>{const epoch=await begin(d);return complete?m('reconcileAdjustments',{...args(d,receipts),complete:true,epoch}):epoch;};
 const settle=(d,id,kind,amountMinor,status='succeeded')=>m(kind==='refund'?'settleSafety':'settleLifecycle',{token:adapter,id,providerRef:(kind==='refund'?'re_':'cn_')+id,receipt:normalized(d,receipt(kind,(kind==='refund'?'re_':'cn_')+id,amountMinor,status,id))});
 const make=async()=>{const id=await m('prepareInvoice',{token:owner,customer,amountMinor:100,currency:'usd',kind:'invoice'}), externalId='in_'+randomUUID();await m('attachProvider',{token:adapter,id,externalId});await m('bindSafetyReference',{token:adapter,id,paymentIntent:'pi_'+randomUUID(),charge:'ch_'+id});await reconcile({id,externalId});return{id,externalId};};
 const observe=(d,refundedMinor,reconciliationEpoch)=>{d.paymentReceipts=[{kind:'payment',receiptId:'inpay_'+d.id,sourceRef:'pi_'+d.id,amountMinor:100,status:'succeeded'}];return m('observe',{token:adapter,binding:f.A.binding,externalId:d.externalId,eventId:randomUUID(),digest:randomUUID(),state:'paid',paidMinor:100,refundedMinor,currency:'usd',...(reconciliationEpoch===undefined?{}:{reconciliationEpoch})});};
 const paid=async d=>{const epoch=await begin(d);await observe(d,0,epoch);await m('reconcileAdjustments',{...args(d),complete:true,epoch});};
 const refund=(d,amountMinor)=>m('prepareSafety',{token:owner,document:d.id,binding:f.A.binding,destination:f.A.key.account,action:'refund',amountMinor,logical:randomUUID()});
 const credit=(d,amountMinor)=>m('prepareLifecycle',{token:owner,document:d.id,action:'credit',amountMinor});
 const get=d=>c.query(api.payments.getDocument,{token:owner,id:d.id});
 const check=async(name,fn)=>{try{await fn();results.push({name,status:'PASS'});}catch(e){results.push({name,status:'FAIL',error:e.message});}console.log(results.at(-1).status+' '+name);};
 await check('Two accepted refund receipts cannot reuse one aggregate observation to restore capacity',async()=>{
  const d=await make();await paid(d);
  const ids=await Promise.all([refund(d,50),refund(d,50)]);
  await Promise.all(ids.map(id=>m('permitSafety',{token:adapter,id})));
  await observe(d,50);await reconcile(d,[receipt('refund','re_'+ids[0],50,'succeeded',ids[0])]);
  for(const id of ids)await settle(d,id,'refund',50);
  const third=await refund(d,50);
  await assert.rejects(m('permitSafety',{token:adapter,id:third}),/remaining paid/);
  assert.equal((await get(d)).refundedMinor,100);
  await observe(d,50);assert.equal((await get(d)).refundedMinor,100,'Older aggregate cannot erase accepted receipts');
 });
 for(const order of ['callback-first','receipt-first'])await check('Credit is counted once with '+order,async()=>{
  const d=await make(),id=await credit(d,50);await m('permitLifecycle',{token:adapter,id});
  const callback=()=>reconcile(d,[receipt('credit','cn_'+id,50,'succeeded',id)]);
  if(order==='callback-first')await callback();
  await settle(d,id,'credit',50);
  if(order==='receipt-first')await callback();
  assert.equal((await get(d)).creditedMinor,50);
  assert.equal(await m('settleLifecycle',{token:adapter,id,providerRef:'cn_'+id}),false);
  const remainder=await credit(d,50);await m('permitLifecycle',{token:adapter,id:remainder});
 });
 await check('Pre-existing refunds, unknown holds and distinct receipts all retain their capacity',async()=>{
  const d=await make();await observe(d,20);const outside=receipt('refund','re_outside_'+d.id,20);await reconcile(d,[outside]);
  const ids=await Promise.all([refund(d,40),refund(d,40)]);
  await Promise.all(ids.map(id=>m('permitSafety',{token:adapter,id})));
  await observe(d,60);await reconcile(d,[outside,receipt('refund','re_'+ids[0],40,'succeeded',ids[0])]);
  await settle(d,ids[0],'refund',40);
  const extra=await refund(d,1);await assert.rejects(m('permitSafety',{token:adapter,id:extra}),/remaining paid/);
  await assert.rejects(m('settleSafety',{token:adapter,id:ids[1],providerRef:'re_'+ids[0]}),/receipt already bound/);
  await settle(d,ids[1],'refund',40);
  assert.equal((await get(d)).refundedMinor,100);
  await observe(d,20);assert.equal((await get(d)).refundedMinor,100);
 });
 await check('Concurrent credits cannot share a receipt or lose accepted value to an older aggregate',async()=>{
  const d=await make();const outside=receipt('credit','cn_outside_'+d.id,20);await reconcile(d,[outside]);
  const ids=await Promise.all([credit(d,40),credit(d,40)]);
  await Promise.all(ids.map(id=>m('permitLifecycle',{token:adapter,id})));
  await reconcile(d,[outside,receipt('credit','cn_'+ids[0],40,'succeeded',ids[0])]);
  await settle(d,ids[0],'credit',40);
  await assert.rejects(m('settleLifecycle',{token:adapter,id:ids[1],providerRef:'cn_'+ids[0]}),/receipt already bound/);
  await settle(d,ids[1],'credit',40);
  await reconcile(d,[outside,receipt('credit','cn_'+ids[0],40,'succeeded',ids[0])]);
  assert.equal((await get(d)).creditedMinor,100);
  const extra=await credit(d,1);await assert.rejects(m('permitLifecycle',{token:adapter,id:extra}),/remaining obligation/);
 });
 await check('Outside refund racing a local receipt has distinct identity and blocks excess capacity',async()=>{
  const d=await make();await paid(d);const id=await refund(d,40);await m('permitSafety',{token:adapter,id});
  const outside=receipt('refund','re_dashboard_'+d.id,50);
  await reconcile(d,[outside]);
  await settle(d,id,'refund',40);
  assert.equal((await get(d)).refundedMinor,90);
  const excessive=await refund(d,11);await assert.rejects(m('permitSafety',{token:adapter,id:excessive}),/remaining paid/);
  const exact=await refund(d,10);await m('permitSafety',{token:adapter,id:exact});
 });
 await check('Partial reconciliation blocks permits and retains unknown reservations',async()=>{
  const d=await make();await paid(d);const id=await refund(d,60);await m('permitSafety',{token:adapter,id});
  await reconcile(d,[],false);
  const next=await refund(d,1);await assert.rejects(m('permitSafety',{token:adapter,id:next}),/reconciliation incomplete/);
  await reconcile(d,[]);
  const excess=await refund(d,41);await assert.rejects(m('permitSafety',{token:adapter,id:excess}),/remaining paid/);
 });
 await check('A real HTTP read failure closes adapter reconciliation before the request',async()=>{
  const d=await make();await paid(d);
  const server=createServer((req,res)=>{assert.equal(req.method,'GET');res.writeHead(503);res.end('{}');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const stripe={request:async(method,path)=>{const response=await fetch('http://127.0.0.1:'+server.address().port+path,{method});if(!response.ok)throw Error('Synthetic provider read unavailable');return response.json();}};
  try{
   await assert.rejects(trustedAdapter(stripe,c,f).observe('A',d.externalId,randomUUID(),randomUUID()),/provider read unavailable/);
   const id=await refund(d,1);await assert.rejects(m('permitSafety',{token:adapter,id}),/reconciliation incomplete/);
  }finally{await new Promise(resolve=>server.close(resolve));}
 });
 await check('General collection adapter cannot dispatch refunds or cancellation under any capability',async()=>{
  const d=await make();let requests=0;
  const server=createServer((req,res)=>{requests++;res.writeHead(503);res.end('{}');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const stripe={request:async(method,path)=>{const response=await fetch('http://127.0.0.1:'+server.address().port+path,{method});if(!response.ok)throw Error('Synthetic provider read unavailable');return response.json();}};
  try{const a=trustedAdapter(stripe,c,f);for(const capability of ['billing.collect','billing.refund','billing.cancelRecurring'])await assert.rejects(a.execute('A',d.id,{},'POST','/v1/refunds',{capability}),/general collection route refused/);await assert.rejects(a.execute('A',d.id,{},'DELETE','/v1/subscriptions/sub_synthetic'),/general collection route refused/);assert.equal(requests,0);}finally{await new Promise(resolve=>server.close(resolve));}
 });
 await check('Receipt identities are account scoped, immutable and cannot move between documents',async()=>{
  const a=await make(),b=await make(),r=receipt('credit','cn_'+a.id,20);await reconcile(a,[r]);
  await assert.rejects(reconcile(b,[r]),/receipt binding mismatch/);
  await assert.rejects(reconcile(a,[{...r,amountMinor:21}]),/receipt binding mismatch/);
  await assert.rejects(reconcile(a,[r,r]),/duplicate adjustment identity/);
  await assert.rejects(m('reconcileAdjustments',{token:f.B.adapter,binding:f.A.binding,externalId:a.externalId,receipts:[],complete:true,refundedMinor:0,creditedMinor:0}),/adapter account denied/);
  const epoch=await begin(a);await assert.rejects(m('reconcileAdjustments',{token:adapter,binding:f.A.binding,externalId:a.externalId,receipts:[],complete:true,epoch,refundedMinor:0,creditedMinor:20}),/incomplete adjustment totals/);
 });
 await check('Newer target generation refuses an older issued snapshot after a credit void',async()=>{
  const d=await make(),r=receipt('credit','cn_'+d.id,50);await reconcile(d,[r]);const old=await begin(d);await reconcile(d,[{...r,status:'cancelled'}]);
  assert.equal((await get(d)).creditedMinor,0);await assert.rejects(m('reconcileAdjustments',{...args(d,[r]),complete:true,epoch:old}),/stale adjustment generation/);assert.equal((await get(d)).creditedMinor,0);
 });
 for(const timing of ['before','after'])await check('Callback '+timing+' a pull observation cannot be overwritten by that pull',async()=>{
  const d=await make();await paid(d);const epoch=await begin(d);
  const ownObserve=()=>m('observe',{token:adapter,binding:f.A.binding,externalId:d.externalId,eventId:randomUUID(),digest:randomUUID(),state:'paid',paidMinor:100,refundedMinor:0,currency:'usd',reconciliationEpoch:epoch});
  if(timing==='after')await ownObserve();
  await observe(d,50);
  if(timing==='before')await assert.rejects(ownObserve(),/stale adjustment generation/);
  await assert.rejects(m('reconcileAdjustments',{...args(d),complete:true,epoch}),/stale adjustment generation/);
  assert.equal((await get(d)).refundedMinor,50);assert.equal((await get(d)).adjustmentsComplete,false);
 });
 await check('A complete adapter HTTP pull observes newly paid and refunded value without invalidating itself',async()=>{
  const d=await make();assert.equal((await get(d)).paidMinor,0);
  const pi='pi_'+d.id,ch='ch_'+d.id,re='re_'+d.id;
  const invoice={id:d.externalId,livemode:false,currency:'usd',amount_paid:100,amount_remaining:0,total:100,status:'paid',pre_payment_credit_notes_amount:0,post_payment_credit_notes_amount:0};
  const refund={id:re,amount:50,charge:ch,payment_intent:pi,currency:'usd',status:'succeeded'};
  const payloads={
   ['/v1/invoices/'+d.externalId]:invoice,
   '/v1/invoice_payments':{data:[{id:'inpay_'+d.id,invoice:d.externalId,currency:'usd',livemode:false,status:'paid',amount_paid:100,payment:{type:'payment_intent',payment_intent:pi}}],has_more:false},
   ['/v1/invoice_payments/inpay_'+d.id]:{id:'inpay_'+d.id,invoice:d.externalId,currency:'usd',livemode:false,status:'paid',amount_paid:100,payment:{type:'payment_intent',payment_intent:pi}},
   ['/v1/payment_intents/'+pi]:{id:pi,livemode:false,currency:'usd',status:'succeeded',amount_received:100,latest_charge:ch},
   ['/v1/charges/'+ch]:{id:ch,payment_intent:pi,livemode:false,currency:'usd',amount:100,amount_refunded:50},
   '/v1/refunds':{data:[refund],has_more:false},['/v1/refunds/'+re]:refund,'/v1/credit_notes':{data:[],has_more:false}
  };
  const server=createServer((req,res)=>{assert.equal(req.method,'GET');assert.equal(req.headers['stripe-account'],f.A.key.account);const value=payloads[new URL(req.url,'http://localhost').pathname];res.writeHead(value?200:404,{'content-type':'application/json'});res.end(JSON.stringify(value??{}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const stripe={request:async(method,path,params,account)=>{const u=new URL(path,'http://127.0.0.1:'+server.address().port);u.search=new URLSearchParams(params).toString();const r=await fetch(u,{method,headers:{'Stripe-Account':account}});assert.equal(r.status,200);return r.json();}};
  try{await trustedAdapter(stripe,c,f).observe('A',d.externalId,randomUUID(),randomUUID());const stored=await get(d);assert.equal(stored.paidMinor,100);assert.equal(stored.refundedMinor,50);assert.equal(stored.adjustmentsComplete,true);const id=await m('prepareSafety',{token:owner,document:d.id,binding:f.A.binding,destination:f.A.key.account,action:'refund',amountMinor:51,logical:randomUUID()});await assert.rejects(m('permitSafety',{token:adapter,id}),/remaining paid/);}finally{await new Promise(resolve=>server.close(resolve));}
 });
 for(const kind of ['refund','credit'])await check('A '+kind+' callback during a pull invalidates its older completion',async()=>{
  const d=await make();await paid(d);const epoch=await begin(d);
  if(kind==='refund')await observe(d,50);
  else await m('observeAdjustment',{token:adapter,id:d.id,creditedMinor:50});
  await assert.rejects(m('reconcileAdjustments',{...args(d),complete:true,epoch}),/stale adjustment generation/);
  const stored=await get(d);assert.equal(stored[kind==='refund'?'refundedMinor':'creditedMinor'],50);assert.equal(stored.adjustmentsComplete,false);
  const id=await refund(d,1);await assert.rejects(m('permitSafety',{token:adapter,id}),/reconciliation incomplete/);
  await reconcile(d,[receipt(kind,(kind==='refund'?'re_':'cn_')+'callback_'+d.id,50)]);
  assert.equal((await get(d)).adjustmentsComplete,true);
 });
 await check('Outside pending refunds stay held until an authoritative terminal refetch',async()=>{
  const d=await make();await paid(d);const r=receipt('refund','re_pending_'+d.id,60,'pending');await reconcile(d,[r]);
  const id=await refund(d,41);await assert.rejects(m('permitSafety',{token:adapter,id}),/remaining paid/);
  await reconcile(d,[]);await assert.rejects(m('permitSafety',{token:adapter,id}),/remaining paid/);
  await reconcile(d,[{...r,status:'failed'}]);await m('permitSafety',{token:adapter,id});assert.equal((await get(d)).refundedMinor,0);
 });
 for(const status of ['needs_response','under_review','warning_needs_response','warning_under_review','lost','unrecognized',null])await check('Refund dispatch refuses disputed value with status '+status,async()=>{
  const d=await make();await paid(d);const id=await refund(d,1);
  await m('observeAdjustment',{token:adapter,id:d.id,disputeAmountMinor:100,...(status?{disputeStatus:status}:{})});
  await assert.rejects(m('permitSafety',{token:adapter,id}),/dispute prevents refund/);
 });
 for(const status of [null,'won','warning_closed'])await check('Refund dispatch remains available after '+(status??'no dispute'),async()=>{
  const d=await make();await paid(d);
  if(status)await m('observeAdjustment',{token:adapter,id:d.id,disputeAmountMinor:100,disputeStatus:status});
  const id=await refund(d,100);await m('permitSafety',{token:adapter,id});
 });
 await check('Binding a pending receipt replaces its exact local hold and rejects unrelated metadata',async()=>{
  const d=await make();await paid(d);const id=await refund(d,60);await m('permitSafety',{token:adapter,id});
  const wrong=normalized(d,receipt('refund','re_wrong_'+d.id,60,'succeeded','unrelated-operation'));
  await assert.rejects(m('settleSafety',{token:adapter,id,providerRef:wrong.receiptId,receipt:wrong}),/operation mismatch/);
  assert.equal((await settle(d,id,'refund',60,'pending')).status,'pending');
  const rest=await refund(d,40);await m('permitSafety',{token:adapter,id:rest});
  await reconcile(d,[receipt('refund','re_'+id,60,'failed',id)]);await m('settleSafety',{token:adapter,id,providerRef:'re_'+id});
  const released=await refund(d,60);await m('permitSafety',{token:adapter,id:released});
 });
});
writeFileSync(new URL('./evidence/accounting.json',import.meta.url),JSON.stringify({level:'SERVICE local Convex; synthetic provider receipts',results},null,2)+'\n');
assert.equal(results.filter(r=>r.status==='FAIL').length,0,JSON.stringify(results.filter(r=>r.status==='FAIL')));
