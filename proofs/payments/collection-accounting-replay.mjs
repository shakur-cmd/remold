import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {trustedAdapter} from './adapter.mjs';
import {writeFileSync} from 'node:fs';
import {ConvexHttpClient} from 'convex/browser';
import {api} from './convex/_generated/api.js';
import {withPayments} from './local.mjs';
const results=[];
await withPayments(async({url,run})=>{
 const c=new ConvexHttpClient(url,{logger:false}),m=(n,a)=>c.mutation(api.payments[n],a),h=(n,a)=>c.mutation(api.harness[n],a);
 async function fixture(){
  const f=run('harness:seed',{run:randomUUID(),tokens:Array.from({length:10},()=>randomUUID())}),owner=f.A.sessions.owner,token=f.A.adapter;
  run('paymentFixture:role',{actor:f.A.actors.owner,role:'finance'});
  const customer=run('paymentFixture:customer',{org:f.A.org,binding:f.A.binding,name:'Exact collection synthetic'});
  const create=async()=>{const id=await m('prepareInvoice',{token:owner,customer,amountMinor:100,currency:'usd',kind:'invoice'}),externalId='in_'+randomUUID();await m('attachProvider',{token,id,externalId});return{id,externalId};};
  const d=await create(),scope=x=>({token,binding:f.A.binding,externalId:x.externalId});
  const pay=(id,amountMinor,op)=>({kind:'payment',receiptId:'inpay_'+id,sourceRef:op?.pi??'pi_'+id,amountMinor,status:'succeeded',...(op?{operationId:op.command}:{})});
  const pull=async(receipts=[],x=d,paid=receipts.filter(r=>r.kind==='payment').reduce((n,r)=>n+r.amountMinor,0))=>{
   const base={...scope(x),receipts,refundedMinor:receipts.filter(r=>r.kind==='refund'&&r.status==='succeeded').reduce((n,r)=>n+r.amountMinor,0),creditedMinor:receipts.filter(r=>r.kind==='credit'&&r.status==='succeeded').reduce((n,r)=>n+r.amountMinor,0)};
   const epoch=await m('reconcileAdjustments',{...base,complete:false});await m('observe',{...scope(x),reconciliationEpoch:epoch,eventId:randomUUID(),digest:randomUUID(),state:paid===100?'paid':'open',paidMinor:paid,refundedMinor:base.refundedMinor,currency:'usd',amountMinor:100});
   return m('reconcileAdjustments',{...base,complete:true,epoch});
  };
  let lastAttempt;
  const collect=async(amount,x=d)=>{
   const logical=x.id+':'+randomUUID(),id=await h('propose',{token:owner,logical,binding:f.A.binding,capability:'billing.collect',payload:{content:'Synthetic exact collection',audience:['synthetic'],audienceVersion:1,destination:f.A.key.account,schedule:0,amountMinor:amount,currency:'usd',workflowVersion:1},reservationUnits:1,maxSteps:1});
   await h('approve',{token:owner,id,expires:Date.now()+60000});const claim=await h('claim',{token:owner,id,worker:'collection-proof'}),permit=await h('permit',{token,id,...claim,worker:'collection-proof'});await h('consume',{token,id,...claim,worker:'collection-proof',version:permit.version,binding:f.A.binding});
   lastAttempt={token,document:x.id,operation:id,amountMinor:amount};const reservation=await m('reserveCollection',lastAttempt);await h('reconcile',{token,id,...claim,providerRef:'pi_'+id,usage:0});
   return{id,reservation,command:createHash('sha256').update(logical).digest('hex'),pi:'pi_'+id};
  };
  const ack=op=>m('recordCollection',{token,id:op.reservation,providerRef:op.pi});
  const credit=async amount=>{const id=await m('prepareLifecycle',{token:owner,document:d.id,action:'credit',amountMinor:amount});await m('permitLifecycle',{token,id});return{kind:'credit',receiptId:'cn_'+id,sourceRef:d.externalId,operationId:id,amountMinor:amount,status:'succeeded'};};
  return{f,owner,token,d,create,pay,pull,collect,ack,credit,retry:()=>m('reserveCollection',lastAttempt)};
 }
 const check=async(name,fn)=>{try{await fn(await fixture());results.push({name,status:'PASS'});}catch(e){results.push({name,status:'FAIL',error:e.message});}console.log(results.at(-1).status+' '+name);};
 for(const amount of [20,21])await check('Exact paid allocation after ack leaves capacity20, request'+amount,async({d,pay,pull,collect,ack})=>{
  const outside=pay('outside_'+d.id,20);await pull([outside]);const local=await collect(60);await ack(local);await pull([outside,pay(local.id,60,local)]);
  if(amount===20)await collect(amount);else await assert.rejects(collect(amount),/remaining obligation/);
 });
 await check('Receipt before acknowledgement retains hold, then exact acknowledgement permits20',async({d,pay,pull,collect,ack,retry})=>{
  const outside=pay('outside_'+d.id,20);await pull([outside]);const local=await collect(60);await pull([outside,pay(local.id,60,local)]);
  await assert.rejects(collect(20),/remaining obligation/);await ack(local);await retry();
 });
 await check('Real loopback adapter dispatch binds the approved command hash to the PI receipt',async({f,owner,d,pay,pull,collect})=>{
  const outside=pay('outside_'+d.id,20);await pull([outside]);let sent;
  const server=createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.method==='GET'){res.end(JSON.stringify({charges_enabled:true}));return;}let body='';for await(const chunk of req)body+=chunk;sent={path:req.url,params:Object.fromEntries(new URLSearchParams(body)),account:req.headers['stripe-account']};res.end(JSON.stringify({id:'pi_loopback',livemode:false}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const stripe={request:async(method,path,params={},account)=>{const response=await fetch('http://127.0.0.1:'+server.address().port+path,{method,headers:{'Stripe-Account':account??''},...(method==='POST'?{body:new URLSearchParams(params)}:{})});assert.equal(response.status,200);return response.json();}};
  try{const params={amount:60,currency:'usd'},stage='synthetic-partial-1';const result=await trustedAdapter(stripe,c,f).execute('A',d.id,params,'POST','/v1/payment_intents',{stage});
   const operation=await c.query(api.harness.operation,{token:owner,id:result.operation}),command=createHash('sha256').update(operation.logical).digest('hex');
   assert.equal(sent.path,'/v1/payment_intents');assert.equal(sent.account,f.A.key.account);assert.equal(sent.params['metadata[remold_command]'],command);
   assert.equal(operation.payload.content,createHash('sha256').update(JSON.stringify({...params,'metadata[remold_command]':command})).digest('hex'));
   await pull([outside,pay(result.operation,60,{pi:result.result.id,command})]);await collect(20);
  }finally{await new Promise(resolve=>server.close(resolve));}
 });
 await check('Same provider PI cannot acknowledge two local holds',async({pull,collect,ack})=>{await pull();const a=await collect(30),b=await collect(30);await ack(a);await assert.rejects(ack({...b,pi:a.pi}),/receipt already bound/);});
 for(const defect of ['duplicate','wrong-amount','wrong-command','missing','regressed','sum','duplicate-pi'])await check('Complete payment reconciliation refuses '+defect,async({d,pay,pull,collect,ack})=>{
  await pull();const op=await collect(60);await ack(op);const r=pay(op.id,60,op);await pull([r]);
  const receipts=defect==='duplicate'?[r,r]:defect==='wrong-amount'?[{...r,amountMinor:59}]:defect==='wrong-command'?[{...r,operationId:'foreign_command'}]:defect==='missing'?[]:defect==='regressed'?[{...r,status:'cancelled'}]:defect==='duplicate-pi'?[r,{...r,receiptId:'inpay_other'}]:[r];
  await assert.rejects(pull(receipts,d,defect==='sum'?61:receipts.filter(x=>x.status==='succeeded').reduce((n,x)=>n+x.amountMinor,0)));
  await assert.rejects(collect(1),/reconciliation incomplete/);
 });
 await check('A known PI allocation cannot move to another invoice under a new receipt ID',async({d,create,pay,pull})=>{const r=pay('outside_'+d.id,20);await pull([r]);const other=await create();await assert.rejects(pull([{...r,receiptId:'inpay_other'}],other),/shared payment allocation/);});
 await check('Payment metadata from another document cannot release its hold',async({create,pay,pull,collect,ack})=>{await pull();const local=await collect(40);await ack(local);const other=await create();await assert.rejects(pull([pay(local.id,40,local)],other),/command document mismatch/);});
 for(const callback of [false,true])for(const amount of [70,71])await check('Credit '+(callback?'receipt before ack':'in flight')+' leaves70, request'+amount,async({pull,credit,collect})=>{await pull();const r=await credit(30);if(callback)await pull([r]);if(amount===71)await assert.rejects(collect(amount),/remaining obligation/);else await collect(amount);});
 await check('Refunds do not reopen gross paid collection capacity',async({d,pay,pull,collect})=>{await pull([pay('outside_'+d.id,100),{kind:'refund',receiptId:'re_'+d.id,sourceRef:'ch_'+d.id,amountMinor:30,status:'succeeded'}]);await assert.rejects(collect(30));});
});
writeFileSync(new URL('./evidence/collection-accounting.json',import.meta.url),JSON.stringify({level:'SERVICE local Convex; synthetic normalized provider records, no Stripe calls',results},null,2)+'\n');
assert.equal(results.filter(r=>r.status==='FAIL').length,0,JSON.stringify(results.filter(r=>r.status==='FAIL')));
