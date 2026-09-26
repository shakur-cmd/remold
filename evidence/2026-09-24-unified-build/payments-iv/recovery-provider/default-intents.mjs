import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {provider,credentials} from '../../../../proofs/payments/stripe.mjs';
const stem='3f7c6229-f345-4b59-8b6a-971208c4efe7-manual-continuation-1',account='acct_1UJIndJL8hhTtG1o',customer='cus_VJzrZTORGay5Lp';
const proof=JSON.parse(readFileSync(new URL('../../../../proofs/payments/evidence/sandbox-'+stem+'-recovery-1.json',import.meta.url)));
const stripe=provider(credentials()),guard=await stripe.verify(),read=(path,params={})=>stripe.request('GET',path,params,account);
const all=await read('/v1/payment_intents',{customer,limit:100});assert.equal(all.has_more,false);
const expected=new Set(proof.objects.filter(x=>x.id.startsWith('pi_')).map(x=>x.id));
const extra=[];
for(const item of all.data.filter(x=>!expected.has(x.id))){
 const pi=await read('/v1/payment_intents/'+item.id);assert.equal(pi.customer,customer);assert.equal(pi.livemode,false);
 const fields={};for(const key of ['id','amount','amount_received','amount_capturable','currency','status','customer','latest_charge','payment_method','confirmation_method','capture_method','canceled_at','cancellation_reason','application_fee_amount','transfer_data','on_behalf_of','setup_future_usage','invoice','metadata'])fields[key]={present:Object.hasOwn(pi,key),value:pi[key]??null};
 extra.push(fields);
}
const invoices=[];
for(const row of proof.objects.filter(x=>x.id.startsWith('in_'))){
 const inv=await read('/v1/invoices/'+row.id),payments=await read('/v1/invoice_payments',{invoice:row.id,limit:100});assert.equal(payments.has_more,false);
 invoices.push({id:inv.id,kind:row.kind,status:inv.status,total:inv.total,paid:inv.amount_paid,remaining:inv.amount_remaining,auto_advance:inv.auto_advance,collection_method:inv.collection_method,payments:payments.data.map(x=>({id:x.id,invoice:x.invoice,is_default:x.is_default,status:x.status,amount_requested:x.amount_requested,amount_paid:x.amount_paid,payment:x.payment})),complete:true});
}
const charges=await read('/v1/charges',{customer,limit:100});assert.equal(charges.has_more,false);
const result={at:new Date().toISOString(),level:'SANDBOX exact scoped GET diagnostic, no mutations',guard,account,customer,totalPaymentIntents:all.data.length,explicitPaymentIds:[...expected],extra,invoices,charges:charges.data.map(x=>({id:x.id,paymentIntent:x.payment_intent,amount:x.amount,paid:x.paid,refunded:x.amount_refunded})),chargeInventoryComplete:true,receipts:stripe.receipts};
writeFileSync(new URL('./default-intents.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({extra:extra.map(x=>({id:x.id.value,status:x.status.value,received:x.amount_received.value,latestCharge:x.latest_charge.value})),charges:charges.data.length}));
