import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {provider,credentials} from '../../../../proofs/payments/stripe.mjs';
const checkpoint=JSON.parse(readFileSync(new URL('./checkpoint.json',import.meta.url)));
const proof=JSON.parse(readFileSync(new URL('../../../../proofs/payments/evidence/sandbox-'+checkpoint.runId+'-recovery-1.json',import.meta.url)));
const stripe=provider(credentials()),guard=await stripe.verify(),account=checkpoint.customers[0].account,customer=checkpoint.customers[0].customer,rows=[],invoices=[];
assert.equal(proof.receipts.filter(x=>x.method==='POST'&&x.path==='/v1/payment_intents').length,5);
assert.equal(proof.receipts.filter(x=>x.method==='POST'&&x.path.startsWith('/v1/payment_intents/')).length,0);
for(const known of checkpoint.payments){
 const pi=await stripe.request('GET','/v1/payment_intents/'+known.id,{},account);assert.equal(pi.customer,customer);assert.equal(pi.livemode,false);assert.match(pi.metadata.remold_command,/^[a-f0-9]{64}$/);
 if(known.kind==='bounded-late')assert.equal(pi.metadata.remold_fixture,undefined);else assert.equal(pi.metadata.remold_fixture,checkpoint.runId);
 rows.push({id:pi.id,kind:known.kind,created:pi.created,commandDigestPresent:true,runMarker:known.kind==='bounded-late'?'absent in approved boundary request':'matches exact continuation run'});
}
for(const known of checkpoint.defaultIntents){
 const pi=await stripe.request('GET','/v1/payment_intents/'+known.id,{},account);assert.equal(pi.customer,customer);assert.equal(pi.livemode,false);assert.deepEqual(pi.metadata,{});assert.equal(pi.amount_received,0);assert.equal(pi.latest_charge,null);assert.equal(pi.amount_capturable,0);assert.equal(pi.payment_method,null);assert.equal(pi.status,known.status);
 const inv=await stripe.request('GET','/v1/invoices/'+known.invoiceLink.invoice,{},account);assert.equal(inv.customer,customer);assert.equal(inv.auto_advance,false);assert.equal(inv.collection_method,'send_invoice');
 if(pi.status==='canceled')assert.equal(pi.cancellation_reason,inv.status==='void'?'void_invoice':'duplicate');else assert.equal(pi.cancellation_reason,null);
 rows.push({id:pi.id,kind:'invoice-linked uncharged',invoice:inv.id,created:pi.created,invoiceFinalizedAt:inv.status_transitions.finalized_at,emptyMetadata:true,cancellationReason:pi.cancellation_reason,status:pi.status});
 invoices.push({id:inv.id,status:inv.status,remaining:inv.amount_remaining,autoAdvance:inv.auto_advance,collectionMethod:inv.collection_method,dueDate:inv.due_date,nextPaymentAttempt:inv.next_payment_attempt,hostedUrlPresent:typeof inv.hosted_invoice_url==='string',hostedUrlOpened:false});
}
writeFileSync(new URL('./provenance.json',import.meta.url),JSON.stringify({status:'PASS',at:new Date().toISOString(),guard,providerExplicitCreateCount:5,providerDirectPiUpdateOrCancelCount:0,rows,invoices,receipts:stripe.receipts,limits:'No hosted URL fetched or printed. Current associations and timing support default creation inference; historical default flag not independently witnessed.'},null,2)+'\n');console.log(JSON.stringify({status:'PASS',gets:stripe.receipts.length,pis:rows.length,invoices:invoices.length}));
