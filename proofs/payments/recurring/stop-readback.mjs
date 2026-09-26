import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {provider,credentials} from '../stripe.mjs';
import {loadFirstStop} from './continuation.mjs';
import {assertSameInvoice} from './provider-evidence.mjs';
import {withRecurring} from './local.mjs';
const prior=loadFirstStop(),stripe=provider(credentials()),get=(path,params={},account='acct_1UJIndJL8hhTtG1o')=>stripe.request('GET',path,params,account),out=new URL('../evidence/recurring-sandbox-continuation/',import.meta.url);
const proof={at:new Date().toISOString(),scope:'Second stop: exact existing SANDBOX resources, GET only',clocks:[],inventories:[],invoices:[],receipts:stripe.receipts};
for(const c of [prior.F,prior.H]){const v=await get('/v1/test_helpers/test_clocks/'+c.id);assert.equal(v.id,c.id);assert.equal(v.livemode,false);proof.clocks.push({id:v.id,label:c.label,status:v.status,frozenTime:v.frozen_time,deletesAfter:v.deletes_after});}
for(const customer of [prior.customerF,prior.customerH])for(const path of ['/v1/subscription_schedules','/v1/subscriptions','/v1/invoices']){const list=await get(path,{customer,limit:100,...(path==='/v1/subscriptions'?{status:'all'}:{})});assert.equal(list.has_more,false);proof.inventories.push({path,customer,ids:list.data.map(x=>x.id),statuses:list.data.map(x=>x.status)});}
const s=await get('/v1/subscription_schedules/'+prior.commitment.schedule),sub=await get('/v1/subscriptions/'+prior.commitment.subscription);
proof.schedule={id:s.id,status:s.status,subscription:s.subscription,releasedSubscription:s.released_subscription,customer:s.customer,testClock:s.test_clock};proof.subscription={id:sub.id,status:sub.status,schedule:sub.schedule,customer:sub.customer,testClock:sub.test_clock};
for(const id of proof.inventories.find(x=>x.path==='/v1/invoices'&&x.customer===prior.customerF).ids){const a=await get('/v1/invoices/'+id),b=await get('/v1/invoices/'+id);assertSameInvoice(a,b);const {hosted_invoice_url,invoice_pdf,...financial}=a;const p=await get('/v1/invoice_payments',{invoice:id,limit:100});assert.equal(p.has_more,false);proof.invoices.push({id:a.id,customer:a.customer,subscription:a.parent.subscription_details.subscription,status:a.status,amountDue:a.amount_due,amountPaid:a.amount_paid,amountRemaining:a.amount_remaining,autoAdvance:a.auto_advance,nextPaymentAttempt:a.next_payment_attempt,attemptCount:a.attempt_count,financialStable:true,financialSha256:createHash('sha256').update(JSON.stringify(financial)).digest('hex'),payments:p.data.map(x=>({id:x.id,status:x.status,amountPaid:x.amount_paid,payment:x.payment}))});}
const e=await get('/v1/test_helpers/test_clocks',{limit:100},'acct_1UJL2DR59Pk6MTFE');assert.equal(e.has_more,false);proof.eClockIds=e.data.map(x=>x.id);writeFileSync(new URL('second-stop-readback.json',out),JSON.stringify(proof,null,2)+'\n');
await withRecurring(async({run,cwd})=>{const snapshot=run('recurring:inspect',{token:prior.fixture.A.sessions.owner,id:prior.commitment.local});writeFileSync(new URL('second-stop-local.json',out),JSON.stringify({at:new Date().toISOString(),cwd,...snapshot},null,2)+'\n');},{resumeDirectory:prior.local.cwd});
console.log('PASS stable second-stop invoice snapshots and original local ledger; '+stripe.receipts.length+' GETs, zero provider writes');
