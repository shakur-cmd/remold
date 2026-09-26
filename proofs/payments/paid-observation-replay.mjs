import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {ConvexHttpClient} from 'convex/browser';
import {api} from './convex/_generated/api.js';
import {withPayments} from './local.mjs';
const results=[];
await withPayments(async({url,run})=>{
 const c=new ConvexHttpClient(url,{logger:false});
 const m=(n,a)=>c.mutation(api.payments[n],a),h=(n,a)=>c.mutation(api.harness[n],a);
 for(const scenario of ['before-own-observe','after-own-observe','lower-callback','renewal','first-unpaid-observation','never-observed-intent','pending-void','voided','outside-paid-plus-local','unpaid-credit','collection-before-void','bound-never-pulled','collection-before-credit']){
  const row={scenario};
  try{
   const f=run('harness:seed',{run:randomUUID(),tokens:Array.from({length:10},()=>randomUUID())}),owner=f.A.sessions.owner,adapter=f.A.adapter;
   run('paymentFixture:role',{actor:f.A.actors.owner,role:'finance'});
   const customer=run('paymentFixture:customer',{org:f.A.org,binding:f.A.binding,name:'Paid fence synthetic'});
   let id=await m('prepareInvoice',{token:owner,customer,amountMinor:100,currency:'usd',kind:scenario==='renewal'?'recurring':'invoice'}),externalId='in_'+randomUUID();
   if(scenario!=='never-observed-intent')await m('attachProvider',{token:adapter,id,externalId});
   const scope=()=>({token:adapter,binding:f.A.binding,externalId,refundedMinor:0,creditedMinor:0,receipts:[]});
   const begin=()=>m('reconcileAdjustments',{...scope(),complete:false}),complete=async epoch=>{const d=await c.query(api.payments.getDocument,{token:owner,id});return m('reconcileAdjustments',{...scope(),complete:true,epoch,receipts:d.paidMinor?[{kind:'payment',receiptId:'inpay_'+id,sourceRef:'pi_outside_'+id,amountMinor:d.paidMinor,status:'succeeded'}]:[]});};
   const observe=(paidMinor,epoch)=>m('observe',{token:adapter,binding:f.A.binding,externalId,eventId:randomUUID(),digest:randomUUID(),state:paidMinor===100?'paid':'open',paidMinor,refundedMinor:0,currency:'usd',...(epoch===undefined?{}:{reconciliationEpoch:epoch})});
   const pull=async paid=>{const epoch=await begin();await observe(paid,epoch);await complete(epoch);};
   const get=()=>c.query(api.payments.getDocument,{token:owner,id});
   const allowed=async fn=>{try{await fn();return true;}catch{return false;}};
   const voidAllowed=async()=>{const op=await m('prepareLifecycle',{token:owner,document:id,action:'void',amountMinor:0});return allowed(()=>m('permitLifecycle',{token:adapter,id:op}));};
   const collectAllowed=async(amount=100,confirm=false)=>{
    const op=await h('propose',{token:owner,logical:id+':'+randomUUID(),binding:f.A.binding,capability:'billing.collect',payload:{content:'Synthetic paid-fence collection',audience:['synthetic'],audienceVersion:1,destination:f.A.key.account,schedule:0,amountMinor:amount,currency:'usd',workflowVersion:1},reservationUnits:1,maxSteps:1});
    await h('approve',{token:owner,id:op,expires:Date.now()+60000});const claim=await h('claim',{token:owner,id:op,worker:'paid-fence'}),permit=await h('permit',{token:adapter,id:op,...claim,worker:'paid-fence'});
    await h('consume',{token:adapter,id:op,...claim,worker:'paid-fence',version:permit.version,binding:f.A.binding});
    let reservation;const accepted=await allowed(async()=>{reservation=await m('reserveCollection',{token:adapter,document:id,operation:op,amountMinor:amount});});
    if(accepted&&confirm){await m('recordCollection',{token:adapter,id:reservation,providerRef:'pi_'+op});await h('reconcile',{token:adapter,id:op,...claim,providerRef:'pi_'+op,usage:0});}
    return accepted;
   };
   if(scenario==='bound-never-pulled'){row.collectionAllowed=await collectAllowed();row.voidAllowed=await voidAllowed();assert.equal(row.collectionAllowed,false);assert.equal(row.voidAllowed,false);
   }else if(scenario==='collection-before-credit'){await pull(0);assert.equal(await collectAllowed(40,true),true);const op=await m('prepareLifecycle',{token:owner,document:id,action:'credit',amountMinor:30});row.creditAllowed=await allowed(()=>m('permitLifecycle',{token:adapter,id:op}));assert.equal(row.creditAllowed,false);
   }else if(['pending-void','voided'].includes(scenario)){
    await pull(0);const command=await m('prepareLifecycle',{token:owner,document:id,action:'void',amountMinor:0});await m('permitLifecycle',{token:adapter,id:command});
    if(scenario==='voided')await m('settleLifecycle',{token:adapter,id:command,providerRef:externalId});
    row.collectionAllowed=await collectAllowed();assert.equal(row.collectionAllowed,false);
   }else if(scenario==='collection-before-void'){
    await pull(0);row.collectionAllowed=await collectAllowed(40,true);assert.equal(row.collectionAllowed,true);row.voidAllowed=await voidAllowed();assert.equal(row.voidAllowed,false,'Pending local collection blocks void');
   }else if(scenario==='outside-paid-plus-local'){
    await pull(20);row.firstLocal=await collectAllowed(60,true);assert.equal(row.firstLocal,true);row.extraLocal=await collectAllowed(30);row.totalPotential=20+60+(row.extraLocal?30:0);assert.equal(row.extraLocal,false,'Outside20 plus local60 leaves only20, not30');
   }else if(scenario==='unpaid-credit'){
    await pull(0);const command=await m('prepareLifecycle',{token:owner,document:id,action:'credit',amountMinor:30});await m('permitLifecycle',{token:adapter,id:command});await m('settleLifecycle',{token:adapter,id:command,providerRef:'cn_'+command,receipt:{kind:'credit',receiptId:'cn_'+command,sourceRef:externalId,operationId:command,amountMinor:30,status:'succeeded'}});
    row.creditedMinor=(await get()).creditedMinor;row.collectionAllowed=await collectAllowed(100);assert.equal(row.collectionAllowed,false,'Unpaid100 less credit30 cannot collect100');
   }else if(scenario==='never-observed-intent'){
    assert.equal((await get()).adjustmentsComplete,undefined);row.collectionAllowed=await collectAllowed();assert.equal(row.collectionAllowed,true);
   }else if(scenario==='first-unpaid-observation'){
    await observe(0);row.before=(await get()).adjustmentsComplete;row.voidBefore=await voidAllowed();assert.equal(row.before,false);assert.equal(row.voidBefore,false);
    await pull(0);assert.equal((await get()).adjustmentsComplete,true);row.collectionAfter=await collectAllowed();assert.equal(row.collectionAfter,true);
   }else{
    if(scenario==='renewal'){
     const parent=id,subscription='sub_'+randomUUID();await m('bindSafetyReference',{token:adapter,id:parent,subscription});externalId='in_renewal_'+randomUUID();
     const renewal=paid=>m('observeRenewal',{token:adapter,parent,subscription,invoice:externalId,amountMinor:100,currency:'usd',paidMinor:paid,state:paid?'paid':'open',eventId:randomUUID(),digest:randomUUID()});
     id=await renewal(0);await pull(0);const epoch=await begin();await renewal(100);
     row.staleAccepted=await allowed(async()=>{await observe(0,epoch);await complete(epoch);});
    }else if(scenario==='lower-callback'){await pull(100);await observe(0);}
    else {const epoch=await begin();if(scenario==='after-own-observe')await observe(0,epoch);await observe(100);row.staleAccepted=await allowed(async()=>{if(scenario==='before-own-observe')await observe(0,epoch);await complete(epoch);});}
    const d=await get();row.after={paidMinor:d.paidMinor,state:d.state,complete:d.adjustmentsComplete};row.voidAllowed=await voidAllowed();row.collectionAllowed=await collectAllowed();
    assert.notEqual(row.staleAccepted,true);assert.equal(row.after.complete,false);assert.equal(row.voidAllowed,false);assert.equal(row.collectionAllowed,false);
    await pull(100);assert.equal((await get()).paidMinor,100);assert.equal((await get()).adjustmentsComplete,true);
   }
   row.status='PASS';
  }catch(e){row.status='FAIL';row.error=e.message;}
  results.push(row);console.log(row.status+' '+scenario);
 }
});
writeFileSync(new URL('./evidence/paid-observation.json',import.meta.url),JSON.stringify({level:'SERVICE local Convex, synthetic observations; no provider calls',results},null,2)+'\n');
assert.equal(results.filter(r=>r.status==='FAIL').length,0,JSON.stringify(results.filter(r=>r.status==='FAIL')));
