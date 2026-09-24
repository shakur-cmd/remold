import assert from'node:assert/strict';import{randomUUID}from'node:crypto';import{writeFileSync}from'node:fs';import{ConvexHttpClient}from'convex/browser';import{api}from'./convex/_generated/api.js';import{withPayments}from'./local.mjs';
const results=[];
await withPayments(async({url,run})=>{
 const c=new ConvexHttpClient(url,{logger:false}),f=run('harness:seed',{run:randomUUID(),tokens:Array.from({length:10},()=>randomUUID())});
 const m=(n,a)=>c.mutation(api.payments[n],a),q=(n,a)=>c.query(api.payments[n],a),a=(n,p)=>c.action(api.payments[n],p);
 const customer=run('paymentFixture:customer',{org:f.A.org,binding:f.A.binding,name:'Public synthetic'}),id=await m('prepareInvoice',{token:f.A.sessions.owner,customer,amountMinor:501,currency:'usd',kind:'invoice'});
 await m('attachProvider',{token:f.A.adapter,id,externalId:'in_synthetic_public'});
 await m('bindPaymentPage',{token:f.A.adapter,id,url:'https://invoice.stripe.com/i/synthetic-proof'});
 const link=await a('issuePaymentLink',{token:f.A.sessions.owner,id,expires:Date.now()+60000});
 await assert.rejects(q('publicPayment',{token:link.token+'changed'}),/invalid or expired/);
 const views=await Promise.all([1,2].map(()=>q('publicPayment',{token:link.token})));assert.deepEqual(views[0],views[1]);assert.equal(views[0].amountMinor,501);assert.equal(views[0].url,'https://invoice.stripe.com/i/synthetic-proof');
 await assert.rejects(q('publicPayment',{token:link.token,paid:true}),/extra field/);
 assert.equal((await q('getDocument',{token:f.A.sessions.owner,id})).paidMinor,0);
 await assert.rejects(a('issuePaymentLink',{token:f.B.sessions.owner,id,expires:Date.now()+60000}),/tenant denied/);
 const expired=await a('issuePaymentLink',{token:f.A.sessions.owner,id,expires:Date.now()+1000});await new Promise(r=>setTimeout(r,1100));await assert.rejects(q('publicPayment',{token:expired.token}),/invalid or expired/);
 await assert.rejects(m('bindPaymentPage',{token:f.A.adapter,id,url:'https://invoice.stripe.com.evil.example/x'}),/secure payment origin/);
 results.push({name:'Payment capability resists tamper/expiry/tenant forgery, duplicates reuse one hosted page, redirects cannot settle',status:'PASS'});
});
writeFileSync(new URL('./evidence/public-payment.json',import.meta.url),JSON.stringify({level:'SERVICE, SIM hosted payment URL fixture',results,limits:['Actual secure payment entry/browser journey requires I7 UI.','No invoice email delivery claimed.']},null,2)+'\n');console.log('PASS public payment capability');
