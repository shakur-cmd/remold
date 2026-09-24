import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {ConvexHttpClient} from 'convex/browser';
import {api} from '../../../../proofs/payments/convex/_generated/api.js';
import {withPayments} from '../../../../proofs/payments/local.mjs';
const results=[];
await withPayments(async({url,run})=>{
 const c=new ConvexHttpClient(url,{logger:false}),m=(n,a)=>c.mutation(api.payments[n],a),h=(n,a)=>c.mutation(api.harness[n],a);
 for(const order of ['held','ack-first','receipt-first'])for(const requested of [47,48]){
  const f=run('harness:seed',{run:randomUUID(),tokens:Array.from({length:10},()=>randomUUID())}),owner=f.A.sessions.owner,token=f.A.adapter;
  run('paymentFixture:role',{actor:f.A.actors.owner,role:'finance'});
  const customer=run('paymentFixture:customer',{org:f.A.org,binding:f.A.binding,name:'IV137 synthetic'});
  const document=await m('prepareInvoice',{token:owner,customer,amountMinor:137,currency:'usd',kind:'invoice'}),externalId='in_'+randomUUID();
  await m('attachProvider',{token,id:document,externalId});
  const outside={kind:'payment',receiptId:'inpay_'+randomUUID(),sourceRef:'pi_'+randomUUID().replaceAll('-',''),amountMinor:29,status:'succeeded'};
  const pull=async receipts=>{
   const scope={token,binding:f.A.binding,externalId},args={...scope,refundedMinor:0,creditedMinor:0,receipts};
   const epoch=await m('reconcileAdjustments',{...args,complete:false});
   await m('observe',{...scope,reconciliationEpoch:epoch,eventId:randomUUID(),digest:randomUUID(),state:'open',paidMinor:receipts.reduce((n,r)=>n+r.amountMinor,0),refundedMinor:0,currency:'usd',amountMinor:137});
   await m('reconcileAdjustments',{...args,complete:true,epoch});
  };
  const operation=async amount=>{
   const logical=document+':'+randomUUID(),id=await h('propose',{token:owner,logical,binding:f.A.binding,capability:'billing.collect',payload:{content:'IV capacity',audience:['synthetic'],audienceVersion:1,destination:f.A.key.account,schedule:0,amountMinor:amount,currency:'usd',workflowVersion:1},reservationUnits:1,maxSteps:1});
   await h('approve',{token:owner,id,expires:Date.now()+60000});const claim=await h('claim',{token:owner,id,worker:'iv'}),permit=await h('permit',{token,id,...claim,worker:'iv'});await h('consume',{token,id,...claim,worker:'iv',version:permit.version,binding:f.A.binding});
   return {id,claim,args:{token,document,operation:id,amountMinor:amount},command:createHash('sha256').update(logical).digest('hex'),pi:'pi_'+id};
  };
  await pull([outside]);
  const local=await operation(61),hold=await m('reserveCollection',local.args);
  await h('reconcile',{token,id:local.id,...local.claim,providerRef:local.pi,usage:0});
  const receipt={kind:'payment',receiptId:'inpay_'+randomUUID(),sourceRef:local.pi,operationId:local.command,amountMinor:61,status:'succeeded'};
  const ack=()=>m('recordCollection',{token,id:hold,providerRef:local.pi});
  let prematureRefused=null;
  if(order==='ack-first'){await ack();await pull([outside,receipt]);}
  if(order==='receipt-first')await pull([outside,receipt]);
  const next=await operation(requested);
  if(order==='receipt-first'){
   await assert.rejects(m('reserveCollection',next.args),/remaining obligation/);prematureRefused=true;await ack();
  }
  let allowed=false;
  try{await m('reserveCollection',next.args);allowed=true;}catch(error){assert.match(error.message,/remaining obligation/);}
  assert.equal(allowed,requested===47);
  results.push({order,obligation:137,outsidePaid:29,local:61,requested,allowed,prematureRefused,status:'PASS'});
 }
});
writeFileSync(new URL('./capacity.json',import.meta.url),JSON.stringify({level:'SERVICE local Convex, synthetic financial receipts, no provider calls',results},null,2)+'\n');
console.log(JSON.stringify({passed:results.length,results},null,2));
