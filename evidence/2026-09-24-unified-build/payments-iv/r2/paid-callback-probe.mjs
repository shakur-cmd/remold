import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {ConvexHttpClient} from 'convex/browser';
import {api} from '../../../../proofs/payments/convex/_generated/api.js';
import {withPayments} from '../../../../proofs/payments/local.mjs';
const evidence={level:'SERVICE local Convex; synthetic financial observations; no provider calls',cases:[]};
await withPayments(async({url,run})=>{
 const c=new ConvexHttpClient(url,{logger:false});
 const f=run('harness:seed',{run:randomUUID(),tokens:Array.from({length:10},()=>randomUUID())});
 const m=(name,args)=>c.mutation(api.payments[name],args),h=(name,args)=>c.mutation(api.harness[name],args),owner=f.A.sessions.owner,adapter=f.A.adapter;
 run('paymentFixture:role',{actor:f.A.actors.owner,role:'finance'});
 const customer=run('paymentFixture:customer',{org:f.A.org,binding:f.A.binding,name:'IV paid callback synthetic'});
 const id=await m('prepareInvoice',{token:owner,customer,amountMinor:100,currency:'usd',kind:'invoice'}),externalId='in_'+randomUUID();
 await m('attachProvider',{token:adapter,id,externalId});
 const args={token:adapter,binding:f.A.binding,externalId,refundedMinor:0,creditedMinor:0,receipts:[]};
 const epoch=await m('reconcileAdjustments',{...args,complete:false});
 const observe=(paidMinor,reconciliationEpoch)=>m('observe',{token:adapter,binding:f.A.binding,externalId,eventId:randomUUID(),digest:randomUUID(),state:paidMinor?'paid':'open',paidMinor,refundedMinor:0,currency:'usd',...(reconciliationEpoch===undefined?{}:{reconciliationEpoch})});
 const get=()=>c.query(api.payments.getDocument,{token:owner,id});
 await observe(100);
 const afterCallback=await get();
 let staleError=null;
 try{await observe(0,epoch);await m('reconcileAdjustments',{...args,complete:true,epoch});}catch(e){staleError=e.message;}
 const afterStale=await get();
 const voidId=await m('prepareLifecycle',{token:owner,document:id,action:'void',amountMinor:0});
 let voidPermit=false,voidError=null;
 try{await m('permitLifecycle',{token:adapter,id:voidId});voidPermit=true;}catch(e){voidError=e.message;}
 const op=await h('propose',{token:owner,logical:id+':'+randomUUID(),binding:f.A.binding,capability:'billing.collect',payload:{content:'IV collection',audience:['synthetic'],audienceVersion:1,destination:f.A.key.account,schedule:0,amountMinor:100,currency:'usd',workflowVersion:1},reservationUnits:1,maxSteps:1});
 await h('approve',{token:owner,id:op,expires:Date.now()+60000});
 const claim=await h('claim',{token:owner,id:op,worker:'iv'});
 const permit=await h('permit',{token:adapter,id:op,...claim,worker:'iv'});
 await h('consume',{token:adapter,id:op,...claim,worker:'iv',version:permit.version,binding:f.A.binding});
 let collectionReserved=false,collectionError=null;
 try{await m('reserveCollection',{token:adapter,document:id,operation:op,amountMinor:100});collectionReserved=true;}catch(e){collectionError=e.message;}
 evidence.cases.push({name:'Older unpaid pull after independent paid callback',epoch,afterCallback:{paidMinor:afterCallback.paidMinor,state:afterCallback.state,epoch:afterCallback.adjustmentEpoch},afterStale:{paidMinor:afterStale.paidMinor,state:afterStale.state,complete:afterStale.adjustmentsComplete,epoch:afterStale.adjustmentEpoch},staleError,voidPermit,voidError,collectionReserved,collectionError,status:staleError&&!voidPermit&&!collectionReserved?'PASS':'FAIL'});
});
writeFileSync(new URL('./paid-callback.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
if(evidence.cases.some(c=>c.status==='FAIL'))process.exitCode=1;
