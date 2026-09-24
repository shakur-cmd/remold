import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {api} from './convex/_generated/api.js';
import {pullAdjustments} from './adjustments.mjs';
import {OutcomeUnknown} from './stripe.mjs';

export function trustedAdapter(stripe,client,fixture){
 const m=(name,args)=>client.mutation(api.payments[name],args);
 const h=(name,args)=>client.mutation(api.harness[name],args);
 async function execute(name,document,params,method,path,{beforePermit,afterPermit,timeout=false,stage=path,callerToken,capability='billing.collect'}={}){
  if(capability!=='billing.collect'||method!=='POST'||!/^\/v1\/(invoices|invoiceitems|payment_intents|subscriptions|invoices\/[^/]+\/(finalize|attach_payment|pay))$/.test(path))throw Error('general collection route refused');
  const f=fixture[name];if(!f)throw Error('Unknown trusted binding');
  const value=await client.query(api.payments.issuance,{token:f.adapter,id:document});
  assert.equal(value.document.binding,f.binding);assert.equal(value.account,f.key.account);
  const healthy=await stripe.request('GET','/v1/accounts/'+value.account);if(!healthy.charges_enabled)throw Error('Provider merchant restricted');
  if(params.customer!==undefined)assert.equal(params.customer,value.customer);
  if(params.amount!==undefined){assert.ok(Number.isSafeInteger(params.amount)&&params.amount>0&&params.amount<=value.document.amountMinor);}
  if(params.currency!==undefined)assert.equal(params.currency,value.document.currency);
  const invoiceTarget=/^\/v1\/invoices\/([^/]+)\//.exec(path)?.[1]??params.invoice;
  if(invoiceTarget!==undefined)assert.equal(invoiceTarget,value.document.externalId,'Immutable invoice target mismatch');
  if(path==='/v1/subscriptions'){
   const priceId=params['items[0][price]'];assert.match(priceId??'',/^price_[A-Za-z0-9]+$/);
   const price=await stripe.request('GET','/v1/prices/'+priceId,{},value.account);
   assert.equal(price.unit_amount,value.document.amountMinor);assert.equal(price.currency,value.document.currency);assert.equal(price.recurring?.interval,'month');
  }
  const caller=callerToken??f.sessions.owner;
  const logical=`${document}:${method}:${stage}`;
  const commandDigest=createHash('sha256').update(logical).digest('hex');
  if(timeout&&path!=='/v1/invoices')throw Error('Response-loss proof only supports bounded invoice lookup');
  const providerParams=timeout||path==='/v1/payment_intents'?{...params,'metadata[remold_command]':commandDigest}:params;
  const payload={content:createHash('sha256').update(JSON.stringify(providerParams)).digest('hex'),audience:[value.customer],audienceVersion:1,destination:value.account,schedule:0,amountMinor:params.amount??value.document.amountMinor,currency:value.document.currency,workflowVersion:1};
  const id=await h('propose',{token:caller,logical,binding:f.binding,capability,payload,reservationUnits:1,maxSteps:1});
  await h('approve',{token:f.sessions.owner,id,expires:Date.now()+60000});
  const worker='trusted-stripe-proof',claim=await h('claim',{token:caller,id,worker});
  if(beforePermit)await beforePermit();
  const permit=await h('permit',{token:f.adapter,id,worker,...claim});
  const consumed=await h('consume',{token:f.adapter,id,worker,...claim,version:permit.version,binding:f.binding});
  assert.equal(consumed.providerKey,f.binding);assert.equal(consumed.account,value.account);assert.equal(consumed.payload.content,payload.content);
  const reservation=path==='/v1/payment_intents'&&method==='POST'?await m('reserveCollection',{token:f.adapter,document,operation:id,amountMinor:params.amount}):null;
  if(afterPermit)await afterPermit();
  let result;
  try{result=await stripe.request(method,path,providerParams,consumed.account,consumed.key,{loseResponse:timeout});}
  catch(error){
   if(!(error instanceof OutcomeUnknown))throw error;
   await h('unknown',{token:f.adapter,id,...claim});
   const candidates=await stripe.request('GET',path,{customer:value.customer,limit:100},consumed.account);
   if(candidates.has_more)throw Error('Lookup bound reached; manual reconciliation required');
   const matching=candidates.data.filter(x=>x.metadata?.remold_command===commandDigest);assert.equal(matching.length,1,'Unknown outcome must resolve to exactly one bound object');
   result=matching[0];
   const duplicate=await stripe.request(method,path,providerParams,consumed.account,consumed.key);assert.equal(duplicate.id,result.id);
  }
  if(reservation)await m('recordCollection',{token:f.adapter,id:reservation,providerRef:result.id});
  const receipt=await h('reconcile',{token:f.adapter,id,...claim,providerRef:result.id,usage:0});assert.equal(receipt.accepted,true);
  return{result,operation:id,receipt};
 }
 async function observe(name,invoiceId,eventId,digest){
  const f=fixture[name];
  const scope={token:f.adapter,binding:f.binding,externalId:invoiceId};
  // Close capacity before the first provider read; any failed or partial pull stays closed.
  const epoch=await m('reconcileAdjustments',{...scope,complete:false,refundedMinor:0,creditedMinor:0,receipts:[]});
  const invoice=await stripe.request('GET','/v1/invoices/'+invoiceId,{},f.key.account);assert.equal(invoice.livemode,false);
  const adjustment=await pullAdjustments(stripe,invoice,f.key.account);
  const inserted=await m('observe',{...scope,reconciliationEpoch:epoch,amountMinor:invoice.total,eventId,digest,state:invoice.status,paidMinor:invoice.amount_paid,refundedMinor:adjustment.refundedMinor,currency:invoice.currency});
  await m('reconcileAdjustments',{...scope,complete:true,epoch,refundedMinor:adjustment.refundedMinor,creditedMinor:adjustment.creditedMinor,receipts:adjustment.receipts});
  return{inserted,invoice:{id:invoice.id,status:invoice.status,paidMinor:invoice.amount_paid,remainingMinor:invoice.amount_remaining,totalMinor:invoice.total,currency:invoice.currency,refundedMinor:adjustment.refundedMinor,creditMinor:adjustment.creditedMinor},intents:adjustment.intents};
 }

 return{execute,observe};
}
