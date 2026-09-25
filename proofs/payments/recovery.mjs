import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {claimJournal,CONTINUATION_ID,CUSTOMERS,FIRST_RUN} from './continuation.mjs';
import {invoiceOrigin} from './invoice-contract.mjs';
export const RECOVERY_ID=CONTINUATION_ID+'-recovery-1';
export const RECOVERED_INVOICE='in_1UJM6fJL8hhTtG1oZ5396711';
const digest=value=>createHash('sha256').update(value).digest('hex');
export function readRecoveryParent(privateDirectory){
 const path=join(privateDirectory,CONTINUATION_ID+'.jsonl');assert.equal(statSync(path).mode&0o077,0,'Parent journal must be private');
 const raw=readFileSync(path),pin=JSON.parse(readFileSync(join(privateDirectory,'basil-recovery-parent.json')));assert.ok(digest(raw)===pin.journalSha256,'Parent journal digest mismatch');
 const rows=raw.toString().trim().split('\n').map(JSON.parse),start=rows[0],writes=rows.filter(r=>r.kind==='write-attempt');
 assert.equal(start.id,CONTINUATION_ID);assert.equal(start.sourceAggregate,'3f2328e9e2c936b9258d47edbc7b1047c16a9f0acd2dd6df2402762efbceb7dd');assert.equal(writes.length,4,'Unexpected parent write count');
 assert.deepEqual(writes.map(r=>[r.method,r.path,r.account]),[['POST','/v1/customers/'+CUSTOMERS.A.customer,CUSTOMERS.A.account],['POST','/v1/customers/'+CUSTOMERS.B.customer,CUSTOMERS.B.account],['POST','/v1/invoices',CUSTOMERS.A.account],['POST','/v1/invoices',CUSTOMERS.A.account]]);
 assert.ok(writes[2].idempotencyKey===writes[3].idempotencyKey&&writes[2].payloadDigest===writes[3].payloadDigest,'Parent create replay mismatch');
 for(const w of writes)assert.ok(typeof w.idempotencyKey==='string'&&digest(w.idempotencyKey)===w.idempotencyDigest,'Parent key digest mismatch');
 const responses=rows.filter(r=>r.kind==='write-response'),errors=rows.filter(r=>r.kind==='write-error');assert.equal(responses.length,3);assert.equal(errors.length,1);
 assert.deepEqual(responses.map(r=>[r.sequence,r.objectId,r.receipt?.httpStatus]),[[1,CUSTOMERS.A.customer,200],[2,CUSTOMERS.B.customer,200],[4,RECOVERED_INVOICE,200]]);assert.equal(errors[0].sequence,3);assert.equal(errors[0].receipt?.httpStatus,200);assert.equal(errors[0].outcome,'unknown');
 assert.ok(writes[2].idempotencyKey.endsWith(':POST:deposit-create:step:1'),'Unexpected parent create key shape');
 const saved=rows.filter(r=>r.kind==='local-fixture');assert.equal(saved.length,1);const fixture=saved[0].fixture;
 for(const name of ['A','B']){assert.equal(fixture[name].key.account,CUSTOMERS[name].account);assert.equal(fixture[name].key.environment,'SANDBOX');}
 return{fixture,createLogical:writes[2].idempotencyKey.slice(0,-':step:1'.length),parentJournalSha256:digest(raw),fixtureDigest:digest(JSON.stringify(fixture))};
}
export function claimRecovery({privateDirectory,sourceAggregate}){
 const parent=readRecoveryParent(privateDirectory);
 const journal=claimJournal(privateDirectory,RECOVERY_ID,{sourceAggregate,parentJournalSha256:parent.parentJournalSha256,fixtureDigest:parent.fixtureDigest,invoice:RECOVERED_INVOICE,customer:CUSTOMERS.A.customer,account:CUSTOMERS.A.account});
 return{journal,...parent};
}
export function checkLocalRecovery(finance,operations,recovery){
 const {fixture:f,createLogical}=recovery;assert.equal(finance.documents.length,1,'Unexpected local document count');assert.equal(finance.quotes.length,1,'Unexpected local quote count');
 const d=finance.documents[0],q=finance.quotes[0];assert.equal(d.org,f.A.org);assert.equal(d.binding,f.A.binding);assert.equal(d.externalId,RECOVERED_INVOICE);assert.equal(d.kind,'deposit');assert.equal(d.amountMinor,3001);assert.equal(d.currency,'usd');assert.equal(d.paidMinor,0);assert.equal(d.refundedMinor,0);assert.equal(d.creditedMinor??0,0);assert.equal(d.state,'issued');assert.notEqual(d.adjustmentsComplete,true);
 assert.equal(q._id,d.quote);assert.equal(q.deposit,d._id);assert.equal(q.state,'accepted');assert.equal(q.version,1);assert.equal(d.quoteVersion,q.version);assert.equal(q.amountMinor,10003);assert.equal(q.customer,d.customer);assert.equal(q.binding,d.binding);
 const own=operations.filter(o=>o.org===f.A.org);assert.equal(own.length,1,'Unexpected recovery operation');const op=own[0];assert.ok(op.logical===createLogical,'Create logical key mismatch');assert.equal(op.logical,d._id+':POST:deposit-create');assert.equal(op.binding,f.A.binding);assert.equal(op.state,'confirmed');assert.equal(op.providerRef,RECOVERED_INVOICE);assert.ok(op.receipts?.some(r=>r.providerRef===RECOVERED_INVOICE));
 return{quote:q._id,deposit:d._id,localCustomer:d.customer,createCommand:digest(op.logical)};
}
export async function checkRecoveryProvider(stripe,journal,createCommand){
 for(const [name,{account,customer}]of Object.entries(CUSTOMERS)){
  const c=await stripe.request('GET','/v1/customers/'+customer,{},account);assert.equal(c.id,customer);assert.equal(c.livemode,false);assert.ok(!c.deleted);assert.equal(c.name,'Synthetic P4 customer '+name);assert.equal(c.metadata?.remold_fixture,FIRST_RUN);assert.equal(c.email,'p4-'+FIRST_RUN+'-'+name.toLowerCase()+'@remold.invalid');assert.equal(c.balance,0);
  const cash=await stripe.request('GET','/v1/customers/'+customer+'/cash_balance',{},account);assert.equal(cash.customer,customer);assert.equal(cash.livemode,false);assert.ok(cash.available==null||Object.keys(cash.available).length===0);
  for(const path of ['/v1/invoices','/v1/invoiceitems','/v1/payment_intents','/v1/charges','/v1/subscriptions','/v1/setup_intents','/v1/customers/'+customer+'/balance_transactions']){
   const list=await stripe.request('GET',path,{limit:100,...(!path.includes('/customers/')?{customer}:{}),...(path==='/v1/subscriptions'?{status:'all'}:{})},account);assert.equal(list.has_more,false,'Recovery inventory incomplete');
   if(name==='A'&&path==='/v1/invoices'){assert.equal(list.data.length,1);assert.equal(list.data[0].id,RECOVERED_INVOICE);}else assert.deepEqual(list.data,[],'Unexpected prior customer effect');
  }
 }
 const invoice=await stripe.request('GET','/v1/invoices/'+RECOVERED_INVOICE,{},CUSTOMERS.A.account);assert.equal(invoice.id,RECOVERED_INVOICE);assert.equal(invoice.customer,CUSTOMERS.A.customer);assert.equal(invoice.livemode,false);assert.equal(invoice.status,'draft');assert.equal(invoice.collection_method,'send_invoice');assert.equal(invoice.auto_advance,false);assert.equal(invoice.currency,'usd');
 for(const field of ['total','amount_due','amount_paid','amount_remaining','starting_balance','amount_overpaid','pre_payment_credit_notes_amount','post_payment_credit_notes_amount'])assert.equal(invoice[field],0,'Changed draft '+field);
 assert.equal(invoice.lines?.has_more,false);assert.deepEqual(invoice.lines?.data,[]);assert.equal(invoice.metadata?.remold_fixture,CONTINUATION_ID);assert.equal(invoice.metadata?.remold_command,createCommand);assert.ok(!invoice.subscription&&invoice.parent==null);
 journal.append({kind:'recovery-preconditions',invoice:RECOVERED_INVOICE,...invoiceOrigin(invoice),receipts:stripe.receipts});return invoice;
}
export async function completeDraft({adapter,document,invoice,label,customer,amountMinor,currency,bindPaymentPage,pull}){
 await adapter.execute('A',document,{customer,invoice,amount:amountMinor,currency,description:'Synthetic P4 fixture '+label},'POST','/v1/invoiceitems',{stage:label+'-item'});
 const {result:finalized}=await adapter.execute('A',document,{auto_advance:false},'POST','/v1/invoices/'+invoice+'/finalize');
 await bindPaymentPage(finalized.hosted_invoice_url);await pull(invoice,label+'-finalized');return finalized;
}
