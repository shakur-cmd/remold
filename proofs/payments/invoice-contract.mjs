import assert from 'node:assert/strict';
// Observed sandbox OAuth application, with the exact Basil response contract linked in the handover.
export const SANDBOX_APPLICATION='ca_VJwFj4FcjohaD0wjZKB5vJcllH0TPDnD';
export function invoiceOrigin(invoice){
 const present=Object.hasOwn(invoice,'application_fee_amount');
 if(present)assert.equal(invoice.application_fee_amount,null,'Explicit invoice fee unsupported');
 for(const field of ['transfer_data','on_behalf_of'])if(Object.hasOwn(invoice,field))assert.equal(invoice[field],null,'Invoice transfer/on-behalf route unsupported');
 assert.deepEqual(invoice.issuer,{type:'self'},'Invoice issuer mismatch');assert.equal(invoice.application,SANDBOX_APPLICATION,'Invoice application mismatch');
 return{invoiceFeeField:present?'explicit-null':'absent-unobserved'};
}
export async function proveNoPlatformFee(stripe,{paymentIntent,account,customer,amountMinor,currency='usd'}){
 const empty=(object,field)=>{if(!Object.hasOwn(object,field)){const e=new Error('Fee evidence unobserved: '+field);e.evidenceStatus='UNOBSERVED';throw e;}assert.equal(object[field],null,'Unexpected fee or transfer: '+field);};
 const pi=await stripe.request('GET','/v1/payment_intents/'+paymentIntent,{},account);
 assert.equal(pi.id,paymentIntent);assert.equal(pi.livemode,false);assert.equal(pi.status,'succeeded');assert.equal(pi.customer,customer);assert.equal(pi.amount,amountMinor);assert.equal(pi.amount_received,amountMinor);assert.equal(pi.currency,currency);
 for(const field of ['application_fee_amount','transfer_data','on_behalf_of'])empty(pi,field);
 assert.equal(typeof pi.latest_charge,'string');const charge=await stripe.request('GET','/v1/charges/'+pi.latest_charge,{},account);
 assert.equal(charge.id,pi.latest_charge);assert.equal(charge.livemode,false);assert.equal(charge.payment_intent,paymentIntent);assert.equal(charge.customer,customer);assert.equal(charge.amount,amountMinor);assert.equal(charge.currency,currency);assert.equal(charge.paid,true);
 for(const field of ['application_fee','application_fee_amount','transfer_data','on_behalf_of'])empty(charge,field);
 const fees=await stripe.request('GET','/v1/application_fees',{charge:charge.id,limit:100});assert.equal(fees.has_more,false,'Fee list incomplete');assert.deepEqual(fees.data,[],'Platform fee was collected');
 return{paymentIntent,charge:charge.id,account,status:'PASS',piFee:'explicit-null',chargeFee:'explicit-null',platformFeeList:'complete-empty'};
}
