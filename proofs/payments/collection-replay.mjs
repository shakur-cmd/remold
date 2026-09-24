import assert from'node:assert/strict';import{randomUUID}from'node:crypto';import{writeFileSync}from'node:fs';import{ConvexHttpClient}from'convex/browser';import{api}from'./convex/_generated/api.js';import{withPayments}from'./local.mjs';
const results=[];
await withPayments(async({url,run})=>{
 const c=new ConvexHttpClient(url,{logger:false}),f=run('harness:seed',{run:randomUUID(),tokens:Array.from({length:10},()=>randomUUID())});const m=(n,a)=>c.mutation(api.payments[n],a),h=(n,a)=>c.mutation(api.harness[n],a);
 const customer=run('paymentFixture:customer',{org:f.A.org,binding:f.A.binding,name:'Collection synthetic'}),owner=f.A.sessions.owner,doc=await m('prepareInvoice',{token:owner,customer,amountMinor:1000,currency:'usd',kind:'invoice'});
 const operation=async(amount)=>{const id=await h('propose',{token:owner,logical:doc+':'+randomUUID(),binding:f.A.binding,capability:'billing.collect',payload:{content:'synthetic collection',audience:['synthetic'],audienceVersion:1,destination:f.A.key.account,schedule:0,amountMinor:amount,currency:'usd',workflowVersion:1},reservationUnits:1,maxSteps:1});await h('approve',{token:owner,id,expires:Date.now()+60000});const claim=await h('claim',{token:owner,id,worker:'fixture'}),permit=await h('permit',{token:f.A.adapter,id,...claim,worker:'fixture'});await h('consume',{token:f.A.adapter,id,...claim,worker:'fixture',version:permit.version,binding:f.A.binding});return{id,...claim};};
 const op=await operation(600),args={token:f.A.adapter,document:doc,operation:op.id,amountMinor:600};
 const id=await m('reserveCollection',args);assert.equal(await m('reserveCollection',args),id);
 await assert.rejects(m('reserveCollection',{...args,token:f.B.adapter}),/adapter account denied/);
 await assert.rejects(m('reserveCollection',{...args,amountMinor:601}),/collection payload mismatch/);
 await h('unknown',{token:f.A.adapter,...op});await h('reconcile',{token:f.A.adapter,...op,providerRef:'pi_synthetic',usage:0});
 const next=await operation(500);await assert.rejects(m('reserveCollection',{...args,operation:next.id,amountMinor:500}),/remaining obligation/);
 results.push('A consumed exact H0 permit reserves collection once; unknown delivery blocks excess second charge');
 await m('recordCollection',{token:f.A.adapter,id,providerRef:'pi_synthetic'});assert.equal(await m('recordCollection',{token:f.A.adapter,id,providerRef:'pi_synthetic'}),false);
 await assert.rejects(m('recordCollection',{token:f.A.adapter,id,providerRef:'pi_different'}),/receipt collision/);
 results.push('Accepted collection remains counted and cannot be rebound to another provider result');
});
writeFileSync(new URL('./evidence/collection.json',import.meta.url),JSON.stringify({level:'SERVICE local Convex, SIM settlement; exact unchanged H0 operations',results},null,2)+'\n');console.log(JSON.stringify({passed:results.length}));
