import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {provider,credentials} from '../stripe.mjs';
import {proveNoPlatformFee} from '../invoice-contract.mjs';
import {loadSecondStop} from './continuation.mjs';
import {withRecurring} from './local.mjs';
import {preserveFailure} from './provider-evidence.mjs';
const out=new URL('../evidence/recurring-sandbox-continuation-2/',import.meta.url),run=JSON.parse(readFileSync(new URL('provider.json',out))),prior=loadSecondStop();
assert.equal(run.complete,true);assert.equal(run.run,'p4-recurring-finite-2026-09-24-1-continue-2');
const stripe=provider(credentials()),get=(path,params={},account='acct_1UJIndJL8hhTtG1o')=>stripe.request('GET',path,params,account);
const list=async(path,params,account)=>{const r=await get(path,{...params,limit:100},account);assert.equal(r.has_more,false);return r.data;};
const result={at:new Date().toISOString(),scope:'Root final SANDBOX readback; GET only',clocks:[],inventories:[],commitments:[],invoices:[],fees:[],receipts:stripe.receipts};
try {
 for(const clock of [prior.F,prior.H]){const c=await get('/v1/test_helpers/test_clocks/'+clock.id);assert.equal(c.id,clock.id);assert.equal(c.status,'ready');result.clocks.push({id:c.id,label:clock.label,time:c.frozen_time,deletesAfter:c.deletes_after});}
 for(const customer of [prior.customerF,prior.customerH])for(const path of ['/v1/subscription_schedules','/v1/subscriptions','/v1/invoices','/v1/setup_intents']){const rows=await list(path,{customer,...(path==='/v1/subscriptions'?{status:'all'}:{})});result.inventories.push({customer,path,ids:rows.map(r=>r.id),statuses:rows.map(r=>r.status)});}
 for(const local of run.final){const c=local.commitment,s=await get('/v1/subscription_schedules/'+c.schedule),sub=await get('/v1/subscriptions/'+c.subscription);assert.equal(s.id,c.schedule);assert.equal(sub.id,c.subscription);assert(['completed','canceled'].includes(s.status));assert.equal(sub.status,'canceled');result.commitments.push({local:c._id,schedule:s.id,scheduleStatus:s.status,subscription:sub.id,subscriptionStatus:sub.status,localState:c.state,paidMinor:c.paidMinor,reservedMinor:c.reservedMinor});
  for(const cycle of local.cycles){const i=await get('/v1/invoices/'+cycle.invoice);assert.equal(i.id,cycle.invoice);assert.equal(i.parent.subscription_details.subscription,sub.id);assert.equal(i.customer,sub.customer);assert.equal(i.currency,'usd');assert.equal(i.amount_due,301);assert.equal(i.amount_paid,cycle.paidMinor);const lines=await list('/v1/invoices/'+i.id+'/lines',{}),payments=await list('/v1/invoice_payments',{invoice:i.id});assert.equal(lines.length,1);assert.equal(lines[0].amount,301);result.invoices.push({id:i.id,subscription:sub.id,customer:i.customer,status:i.status,amountPaid:i.amount_paid,amountRemaining:i.amount_remaining,autoAdvance:i.auto_advance,nextPaymentAttempt:i.next_payment_attempt,line:{id:lines[0].id,amount:lines[0].amount,period:lines[0].period,subscription:lines[0].parent.subscription_item_details.subscription,price:lines[0].pricing.price_details.price},payments:payments.map(p=>({id:p.id,status:p.status,amountPaid:p.amount_paid,payment:p.payment}))});
   for(const p of cycle.payments)if(p.status==='succeeded')result.fees.push(await proveNoPlatformFee(stripe,{paymentIntent:p.id,account:'acct_1UJIndJL8hhTtG1o',customer:i.customer,amountMinor:p.amountMinor}));
  }
 }
 const expected=run.final.flatMap(r=>r.cycles.map(c=>c.invoice)).sort();assert.deepEqual(result.inventories.filter(i=>i.path==='/v1/invoices').flatMap(i=>i.ids).sort(),expected);assert.equal(result.invoices.reduce((n,i)=>n+i.amountPaid,0),1505);assert.equal(result.fees.length,5);assert.equal(result.invoices.filter(i=>i.status==='paid').length,5);assert.equal(result.invoices.filter(i=>i.status==='open'&&i.amountRemaining===301&&!i.autoAdvance&&i.nextPaymentAttempt===null).length,1);
 result.eClocks=(await list('/v1/test_helpers/test_clocks',{},'acct_1UJL2DR59Pk6MTFE')).map(c=>c.id);assert.deepEqual(result.eClocks,[]);
 await withRecurring(async({run:call})=>{for(const local of run.final)assert.deepEqual(call('recurring:inspect',{token:prior.fixture.A.sessions.owner,id:local.commitment._id}),local);},{resumeDirectory:prior.local.cwd});
 result.complete=true;writeFileSync(new URL('final-root-readback.json',out),JSON.stringify(result,null,2)+'\n');console.log('PASS final ledger matches six invoices, five paid receipts,1505 collected,602 held; '+stripe.receipts.length+' GETs, zeroPOSTs');
} catch(error) {
 const path=new URL('./private/final-readback-'+Date.now(),import.meta.url).pathname;result.failure=preserveFailure({path,append:()=>{}},error);writeFileSync(new URL('final-root-readback.json',out),JSON.stringify(result,null,2)+'\n');console.error('STOP final readonly check; private diagnostic retained');process.exitCode=1;
}
