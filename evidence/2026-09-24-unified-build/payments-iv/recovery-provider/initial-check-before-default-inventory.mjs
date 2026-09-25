import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {provider,credentials} from '../../../../proofs/payments/stripe.mjs';
const stem='3f7c6229-f345-4b59-8b6a-971208c4efe7-manual-continuation-1';
const bytes=readFileSync(new URL('../../../../proofs/payments/evidence/sandbox-'+stem+'-recovery-1.json',import.meta.url));
const proof=JSON.parse(bytes);assert.equal(proof.runId,stem);assert.equal(proof.results.filter(x=>x.status==='PASS').length,12);assert.equal(proof.results.filter(x=>x.status==='BLOCKED').length,1);assert.equal(proof.failure,undefined);
const customers=[{name:'D',account:'acct_1UJIndJL8hhTtG1o',id:'cus_VJzrZTORGay5Lp',suffix:'a'},{name:'E',account:'acct_1UJL2DR59Pk6MTFE',id:'cus_VJzr8q1ZtrR81v',suffix:'b'}];
const expectedInvoices=proof.objects.filter(x=>x.id.startsWith('in_')),expectedPayments=proof.objects.filter(x=>x.id.startsWith('pi_'));
assert.equal(expectedInvoices.length,5);assert.equal(expectedPayments.length,5);assert.equal(expectedInvoices.find(x=>x.kind==='deposit').id,'in_1UJM6fJL8hhTtG1oZ5396711');
const stripe=provider(credentials()),guard=await stripe.verify(),result={status:'RUNNING',level:'SANDBOX actual Stripe read-only reconciliation',reviewer:'c0_verifier',at:new Date().toISOString(),runId:stem,proofSha256:createHash('sha256').update(bytes).digest('hex'),guard,customers:[],invoices:[],payments:[],receipts:stripe.receipts};
const save=()=>writeFileSync(new URL('./checkpoint.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
const get=(path,params={},account)=>stripe.request('GET',path,params,account);
const list=async(path,params,account)=>{const x=await get(path,{...params,limit:100},account);assert.equal(x.object,'list');assert.equal(x.has_more,false,'Incomplete '+path);assert.ok(Array.isArray(x.data));return x.data;};
const ids=xs=>xs.map(x=>x.id).sort();
try{
 for(const c of customers){
  const customer=await get('/v1/customers/'+c.id,{},c.account);assert.equal(customer.id,c.id);assert.equal(customer.livemode,false);assert.equal(customer.balance,0);assert.equal(customer.metadata.remold_fixture,proof.continuationOf);assert.equal(customer.email,'p4-'+proof.continuationOf+'-'+c.suffix+'@remold.invalid');
  const cash=await get('/v1/customers/'+c.id+'/cash_balance',{},c.account);assert.equal(cash.livemode,false);assert.ok(cash.available==null||Object.keys(cash.available).length===0);
  const inventories={};for(const kind of ['invoices','invoiceitems','payment_intents','charges','subscriptions','setup_intents','balance_transactions']){
   const path=kind==='balance_transactions'?'/v1/customers/'+c.id+'/'+kind:'/v1/'+kind;
   const items=await list(path,{...(kind==='balance_transactions'?{}:{customer:c.id}),...(kind==='subscriptions'?{status:'all'}:{})},c.account);
   if(c.name==='E')assert.equal(items.length,0);
   else if(kind==='invoices')assert.deepEqual(ids(items),ids(expectedInvoices));
   else if(kind==='payment_intents')assert.deepEqual(ids(items),ids(expectedPayments));
   else if(kind==='charges')assert.deepEqual(ids(items),proof.feeEvidence.map(x=>x.charge).sort());
   else if(kind==='invoiceitems'){assert.equal(items.length,5);assert.equal(items.reduce((s,x)=>s+x.amount,0),12584);}
   else assert.equal(items.length,0);
   inventories[kind]={count:items.length,ids:ids(items),complete:true};
  }
  result.customers.push({account:c.account,customer:c.id,originalMetadataMatches:true,syntheticEmailMatches:true,balance:0,cashBalanceEmpty:true,inventories});save();
 }
 for(const row of expectedInvoices){
  const inv=await get('/v1/invoices/'+row.id,{},row.account);assert.equal(inv.id,row.id);assert.equal(inv.customer,customers[0].id);assert.equal(inv.livemode,false);assert.equal(inv.currency,'usd');assert.equal(inv.total,row.amountMinor);assert.equal(inv.auto_advance,false);assert.equal(inv.collection_method,'send_invoice');assert.equal(inv.metadata.remold_fixture,stem);
  assert.equal(inv.lines.has_more,false);assert.equal(inv.lines.data.length,1);assert.equal(inv.lines.data[0].amount,row.amountMinor);
  const payments=await list('/v1/invoice_payments',{invoice:inv.id},row.account);const wanted=expectedPayments.filter(x=>x.invoice===inv.id);
  assert.deepEqual(payments.map(x=>x.payment.payment_intent).sort(),wanted.map(x=>x.id).sort());assert.ok(payments.every(x=>x.status==='paid'&&x.invoice===inv.id));assert.equal(payments.reduce((n,x)=>n+x.amount_paid,0),wanted.reduce((n,x)=>n+x.amountMinor,0));
  const credits=await list('/v1/credit_notes',{invoice:inv.id},row.account);assert.equal(credits.length,row.kind==='credit'?1:0);
  for(const credit of credits){assert.equal(credit.invoice,inv.id);assert.equal(credit.amount,99);assert.equal(credit.status,'issued');assert.equal(credit.currency,'usd');assert.equal(credit.livemode,false);}
  if(['deposit','balance','dispute'].includes(row.kind)){assert.equal(inv.status,'paid');assert.equal(inv.amount_paid,row.amountMinor);assert.equal(inv.amount_remaining,0);}
  if(row.kind==='credit'){assert.equal(inv.status,'open');assert.equal(inv.amount_paid,0);assert.equal(inv.amount_remaining,900);assert.equal(inv.pre_payment_credit_notes_amount,99);}
  if(row.kind==='void'){assert.equal(inv.status,'void');assert.equal(inv.amount_paid,0);}
  result.invoices.push({id:inv.id,kind:row.kind,status:inv.status,total:inv.total,due:inv.amount_due,paid:inv.amount_paid,remaining:inv.amount_remaining,preCredit:inv.pre_payment_credit_notes_amount,postCredit:inv.post_payment_credit_notes_amount,lineCount:1,linesComplete:true,payments:payments.map(x=>({id:x.id,paymentIntent:x.payment.payment_intent,amount:x.amount_paid,status:x.status})),paymentListComplete:true,credits:credits.map(x=>({id:x.id,amount:x.amount,status:x.status})),creditListComplete:true,invoiceFeeField:Object.hasOwn(inv,'application_fee_amount')?'present':'absent-unobserved'});save();
 }
 for(const row of expectedPayments){
  const pi=await get('/v1/payment_intents/'+row.id,{},row.account);assert.equal(pi.id,row.id);assert.equal(pi.customer,customers[0].id);assert.equal(pi.livemode,false);assert.equal(pi.status,'succeeded');assert.equal(pi.amount,row.amountMinor);assert.equal(pi.amount_received,row.amountMinor);assert.equal(pi.currency,'usd');
  for(const f of ['application_fee_amount','transfer_data','on_behalf_of']){assert.ok(Object.hasOwn(pi,f),'PI unobserved '+f);assert.equal(pi[f],null);}
  const ch=await get('/v1/charges/'+pi.latest_charge,{},row.account);assert.equal(ch.id,proof.feeEvidence.find(x=>x.paymentIntent===pi.id).charge);assert.equal(ch.payment_intent,pi.id);assert.equal(ch.customer,customers[0].id);assert.equal(ch.livemode,false);assert.equal(ch.paid,true);assert.equal(ch.amount,row.amountMinor);assert.equal(ch.currency,'usd');
  for(const f of ['application_fee','application_fee_amount','transfer_data','on_behalf_of']){assert.ok(Object.hasOwn(ch,f),'Charge unobserved '+f);assert.equal(ch[f],null);}
  const fees=await list('/v1/application_fees',{charge:ch.id});assert.equal(fees.length,0);
  const refunds=await list('/v1/refunds',{payment_intent:pi.id},row.account),deposit=row.invoice===expectedInvoices.find(x=>x.kind==='deposit').id;
  assert.equal(refunds.length,deposit?1:0);for(const refund of refunds){assert.equal(refund.payment_intent,pi.id);assert.equal(refund.charge,ch.id);assert.equal(refund.amount,101);assert.equal(refund.status,'succeeded');assert.equal(refund.currency,'usd');}assert.equal(ch.amount_refunded,deposit?101:0);
  const disputes=await list('/v1/disputes',{payment_intent:pi.id},row.account),disputed=row.invoice===expectedInvoices.find(x=>x.kind==='dispute').id;
  assert.equal(disputes.length,disputed?1:0);for(const d of disputes){assert.equal(d.id,proof.objects.find(x=>x.id.startsWith('du_')).id);assert.equal(d.payment_intent,pi.id);assert.equal(d.charge,ch.id);assert.equal(d.amount,805);assert.equal(d.currency,'usd');assert.equal(d.livemode,false);assert.equal(d.status,'needs_response');}
  await assert.rejects(get('/v1/payment_intents/'+pi.id),e=>e.status===404);
  result.payments.push({id:pi.id,kind:row.kind,invoice:row.invoice??null,status:pi.status,amount:pi.amount,charge:ch.id,refunded:ch.amount_refunded,feeEvidence:'PI and Charge explicit-null; complete platform charge-filtered fee list empty',refunds:refunds.map(x=>({id:x.id,amount:x.amount,status:x.status})),disputes:disputes.map(x=>({id:x.id,amount:x.amount,status:x.status})),listsComplete:true,notFoundInPlatformScope:true});save();
 }
 assert.ok(stripe.receipts.every(r=>r.method==='GET'));
 result.status='PASS bounded independent post-recovery provider reconciliation';result.totals={invoices:5,invoiceOriginalTotal:result.invoices.reduce((s,x)=>s+x.total,0),grossInvoicePaid:result.invoices.reduce((s,x)=>s+x.paid,0),paymentIntents:5,grossPayments:result.payments.reduce((s,x)=>s+x.amount,0),refund:101,credit:99,dispute:805,boundaryUnattachedPayment:109};
 assert.equal(result.totals.grossInvoicePaid,10808);assert.equal(result.totals.grossPayments,10917);
 result.limits='Exact synthetic customers/objects only. Current provider state, not fresh local authority/webhook/browser replay. Historical partial state and root signed-event checks remain operator evidence. Fees refer to platform application fees, not Stripe processing/dispute fees. Recurring BLOCKED and full P4 open.';save();console.log(JSON.stringify({status:result.status,requests:stripe.receipts.length,totals:result.totals}));
}catch(error){result.status='FAIL';result.failure={message:error.message,status:error.status??null};save();throw error;}
