import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {provider,credentials} from '../../../../proofs/payments/stripe.mjs';
const first='3f7c6229-f345-4b59-8b6a-971208c4efe7',run=first+'-manual-continuation-1';
const invoiceId='in_1UJM6fJL8hhTtG1oZ5396711';
const customers=[{name:'A',account:'acct_1UJIndJL8hhTtG1o',customer:'cus_VJzrZTORGay5Lp'},{name:'B',account:'acct_1UJL2DR59Pk6MTFE',customer:'cus_VJzr8q1ZtrR81v'}];
const originalBytes=readFileSync(new URL('../../../../proofs/payments/evidence/sandbox-'+run+'.json',import.meta.url));
const original=JSON.parse(originalBytes);assert.equal(original.runId,run);assert.equal(original.continuationOf,first);
assert.deepEqual(original.objects,customers.map(r=>({kind:'customer',account:r.account,id:r.customer})));
const stripe=provider(credentials()),guard=await stripe.verify(),rows=[];
const get=(path,params,account)=>stripe.request('GET',path,params,account);
for(const row of customers){
 const c=await get('/v1/customers/'+row.customer,{},row.account);
 assert.equal(c.id,row.customer);assert.equal(c.livemode,false);assert.equal(c.name,'Synthetic P4 customer '+row.name);
 assert.equal(c.metadata?.remold_fixture,first);assert.equal(c.email,'p4-'+first+'-'+row.name.toLowerCase()+'@remold.invalid');assert.equal(c.balance,0);
 const cash=await get('/v1/customers/'+row.customer+'/cash_balance',{},row.account);
 assert.equal(cash.customer,row.customer);assert.equal(cash.livemode,false);assert.ok(cash.available==null||Object.keys(cash.available).length===0);
 const inventory={};
 for(const kind of ['invoices','invoiceitems','payment_intents','charges','subscriptions','setup_intents','balance_transactions']){
  const customerRoute=kind==='balance_transactions';
  const path=customerRoute?'/v1/customers/'+row.customer+'/'+kind:'/v1/'+kind;
  const params={limit:100,...(!customerRoute?{customer:row.customer}:{}),...(kind==='subscriptions'?{status:'all'}:{})};
  const list=await get(path,params,row.account);assert.equal(list.object,'list');assert.equal(list.has_more,false);assert.ok(Array.isArray(list.data));
  const expected=kind==='invoices'&&row.name==='A'?[invoiceId]:[];
  assert.deepEqual(list.data.map(v=>v.id),expected);
  inventory[kind]={count:list.data.length,ids:expected,complete:true,customerScope:row.customer};
 }
 rows.push({...row,testMode:true,originalMetadataMatches:true,syntheticEmailMatches:true,balance:0,cashBalanceEmpty:true,inventory});
}
const invoice=await get('/v1/invoices/'+invoiceId,{},customers[0].account);
assert.equal(invoice.id,invoiceId);assert.equal(invoice.customer,customers[0].customer);assert.equal(invoice.livemode,false);
assert.equal(invoice.status,'draft');assert.equal(invoice.collection_method,'send_invoice');assert.equal(invoice.auto_advance,false);assert.equal(invoice.currency,'usd');
for(const key of ['total','amount_due','amount_paid','amount_remaining','starting_balance','amount_overpaid'])assert.equal(invoice[key],0);
assert.equal(invoice.lines.has_more,false);assert.deepEqual(invoice.lines.data,[]);assert.equal(invoice.metadata?.remold_fixture,run);
const fields={};for(const key of ['id','customer','status','livemode','collection_method','auto_advance','currency','total','amount_due','amount_paid','amount_remaining','starting_balance','amount_overpaid','application_fee_amount','transfer_data','application','on_behalf_of','issuer','parent','subscription'])fields[key]={present:Object.hasOwn(invoice,key),value:invoice[key]??null};
assert.equal(fields.application_fee_amount.present,false);assert.equal(fields.transfer_data.present,false);
assert.ok(stripe.receipts.every(r=>r.method==='GET'&&r.httpStatus===200));
const result={status:'PASS bounded read-only continuation1 checkpoint',reviewer:'c0_verifier',at:new Date().toISOString(),level:'SANDBOX actual Stripe GET responses',runId:run,originalEvidenceSha256:createHash('sha256').update(originalBytes).digest('hex'),guard,rows,invoice:{account:customers[0].account,fields,lineCount:0,linesComplete:true,continuationMetadataMatches:true,feeConclusion:'application_fee_amount and transfer_data absent: unobserved, not proof of zero fees'},receipts:stripe.receipts,limits:'Exact two customers only. No mutations, local backend, private journal access or continuation replay. Whole P4 remains incomplete.'};
writeFileSync(new URL('./checkpoint.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:result.status,getRequests:stripe.receipts.length,drafts:1,lineItems:0,paymentIntents:0,charges:0,feeFields:'absent, unobserved'}));
