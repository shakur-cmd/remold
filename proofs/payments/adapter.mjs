import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {api} from './convex/_generated/api.js';
import {pullAdjustments} from './adjustments.mjs';
import {OutcomeUnknown} from './stripe.mjs';
import {invoiceOrigin} from './invoice-contract.mjs';

export function trustedAdapter(stripe,client,fixture){
 const m=(name,args)=>client.mutation(api.payments[name],args);
 const h=(name,args)=>client.mutation(api.harness[name],args);
 async function execute(name,document,params,method,path,{beforePermit,afterPermit,timeout=false,stage=path,callerToken,capability='billing.collect'}={}){
  if(capability!=='billing.collect'||method!=='POST')throw Error('general collection route refused');
  const route=path==='/v1/invoices'?'create':path==='/v1/invoiceitems'?'item':path==='/v1/payment_intents'?'collect':/^\/v1\/invoices\/[^/]+\/finalize$/.test(path)?'finalize':/^\/v1\/invoices\/[^/]+\/attach_payment$/.test(path)?'attach':null;
  if(!route)throw Error('general collection route refused');
  const keys={create:['customer','collection_method','days_until_due','auto_advance','pending_invoice_items_behavior','currency','metadata[remold_fixture]'],item:['customer','invoice','amount','currency','description'],collect:['customer','amount','currency','payment_method','payment_method_types[]','confirm','metadata[remold_fixture]'],finalize:['auto_advance'],attach:['payment_intent']}[route];
  assert.ok(Object.keys(params).every(key=>keys.includes(key)),'unsupported provider parameter');
  if(params['metadata[remold_fixture]']!==undefined)assert.ok(typeof params['metadata[remold_fixture]']==='string'&&params['metadata[remold_fixture]'].length<=128,'invalid fixture label');
  if(route==='create'){assert.equal(params.collection_method,'send_invoice');assert.equal(params.auto_advance,false);assert.equal(params.pending_invoice_items_behavior,'exclude');assert.ok(Number.isSafeInteger(params.days_until_due)&&params.days_until_due>=1&&params.days_until_due<=30);}
  if(route==='finalize')assert.equal(params.auto_advance,false);
  if(route==='collect'){assert.equal(params.confirm,true);assert.equal(params['payment_method_types[]'],'card');assert.match(params.payment_method??'',/^pm_[A-Za-z0-9_]+$/);}
  if(route==='attach')assert.match(params.payment_intent??'',/^pi_[A-Za-z0-9_]+$/);
  const f=fixture[name];if(!f)throw Error('Unknown trusted binding');
  const value=await client.query(api.payments.issuance,{token:f.adapter,id:document});
  assert.equal(value.document.binding,f.binding);assert.equal(value.account,f.key.account);
  if(['create','item','collect'].includes(route))assert.equal(params.customer,value.customer,'Bound customer required');
  if(['item','collect'].includes(route)){assert.equal(params.currency,value.document.currency);assert.ok(Number.isSafeInteger(params.amount)&&params.amount>0&&params.amount<=value.document.amountMinor);}
  if(route==='create')assert.equal(value.document.externalId,undefined,'Invoice already bound');
  if(route==='item'){assert.equal(params.invoice,value.document.externalId);assert.ok(params.invoice,'Bound invoice required');assert.equal(params.amount,value.document.amountMinor);}
  const healthy=await stripe.request('GET','/v1/accounts/'+value.account);if(!healthy.charges_enabled||healthy.capabilities?.card_payments!=='active'||healthy.requirements?.disabled_reason!==null||!Array.isArray(healthy.requirements?.currently_due)||healthy.requirements.currently_due.length)throw Error('Provider merchant restricted');
  if(params.customer!==undefined)assert.equal(params.customer,value.customer);
  if(params.amount!==undefined){assert.ok(Number.isSafeInteger(params.amount)&&params.amount>0&&params.amount<=value.document.amountMinor);}
  if(params.currency!==undefined)assert.equal(params.currency,value.document.currency);
  const invoiceTarget=/^\/v1\/invoices\/([^/]+)\//.exec(path)?.[1]??params.invoice;
  if(invoiceTarget!==undefined)assert.equal(invoiceTarget,value.document.externalId,'Immutable invoice target mismatch');
  const supportedInvoice=invoice=>{
   assert.equal(invoice.id,value.document.externalId);assert.equal(invoice.customer,value.customer);assert.equal(invoice.currency,value.document.currency);assert.equal(invoice.livemode,false);assert.equal(invoice.collection_method,'send_invoice');assert.equal(invoice.auto_advance,false);assert.ok(!invoice.subscription&&invoice.parent?.type!=='subscription_details','Subscription invoice route unsupported');invoiceOrigin(invoice);
  };
  // Customer-balance/minimum-charge/overpayment effects are not modeled by this route.
  const explainedBalance=invoice=>{
   for(const key of ['total','amount_due','amount_paid','amount_remaining','pre_payment_credit_notes_amount','post_payment_credit_notes_amount','amount_overpaid'])assert.ok(Number.isSafeInteger(invoice[key])&&invoice[key]>=0,'Invalid invoice balance field: '+key);
   assert.ok(Number.isSafeInteger(invoice.starting_balance),'Invalid invoice balance field: starting_balance');
   assert.equal(invoice.starting_balance,0,'Customer balance route unsupported');assert.equal(invoice.amount_overpaid,0,'Overpaid invoice route unsupported');
   assert.equal(invoice.total,value.document.amountMinor,'Invoice obligation mismatch');
   assert.equal(invoice.amount_due,invoice.total-invoice.pre_payment_credit_notes_amount,'Unexplained invoice amount due');
   assert.ok(invoice.amount_paid<=invoice.amount_due,'Overpaid invoice route unsupported');
   assert.equal(invoice.amount_remaining,invoice.amount_due-invoice.amount_paid,'Unexplained invoice remaining');
  };
  const readInvoice=async()=>{assert.ok(value.document.externalId,'Bound invoice required');const invoice=await stripe.request('GET','/v1/invoices/'+value.document.externalId,{},value.account);supportedInvoice(invoice);return invoice;};
  const exactLine=invoice=>{assert.equal(invoice.lines?.has_more,false);assert.equal(invoice.lines?.data?.length,1);assert.equal(invoice.total,value.document.amountMinor);assert.equal(invoice.amount_due,value.document.amountMinor);};
  if(route==='item'){const invoice=await readInvoice();assert.equal(invoice.status,'draft');assert.equal(invoice.lines?.has_more,false);assert.equal(invoice.lines?.data?.length,0,'Invoice already has lines');}
  if(route==='finalize'){const invoice=await readInvoice();assert.equal(invoice.status,'draft');exactLine(invoice);}
  if(route==='collect'&&value.document.externalId){const validate=invoice=>{supportedInvoice(invoice);explainedBalance(invoice);assert.equal(invoice.status,'open');assert.ok(invoice.amount_remaining>=params.amount,'Invoice no longer has collection capacity');};await observe(name,value.document.externalId,'collect:'+randomUUID(),randomUUID(),validate);}
  if(route==='attach'){
   const held=await client.query(api.payments.collectionForAttachment,{token:f.adapter,document,providerRef:params.payment_intent});
   const invoice=await readInvoice();explainedBalance(invoice);assert.equal(invoice.status,'open');assert.ok(invoice.amount_remaining>=held.amountMinor,'Invoice no longer has collection capacity');
   const pi=await stripe.request('GET','/v1/payment_intents/'+params.payment_intent,{},value.account);
   assert.equal(pi.id,params.payment_intent);assert.equal(pi.livemode,false);assert.equal(pi.status,'succeeded');assert.equal(pi.customer,value.customer);assert.equal(pi.currency,value.document.currency);assert.equal(pi.amount,held.amountMinor);assert.equal(pi.amount_received,held.amountMinor);assert.equal(pi.metadata?.remold_command,held.command);
   const allocated=await stripe.request('GET','/v1/invoice_payments',{invoice:invoice.id,limit:100},value.account);assert.equal(allocated.has_more,false);assert.ok(Array.isArray(allocated.data)&&!allocated.data.some(p=>p.payment?.payment_intent===pi.id),'Payment already attached');
  }
  const caller=callerToken??f.sessions.owner;
  const logical=`${document}:${method}:${stage}`;
  const commandDigest=createHash('sha256').update(logical).digest('hex');
  if(timeout&&path!=='/v1/invoices')throw Error('Response-loss proof only supports bounded invoice lookup');
  const providerParams=timeout||route==='create'||route==='collect'?{...params,'metadata[remold_command]':commandDigest}:params;
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
  if(route==='finalize'){assert.equal(result.id,value.document.externalId);assert.equal(result.status,'open');assert.equal(result.collection_method,'send_invoice');assert.equal(result.auto_advance,false);assert.equal(result.livemode,false);assert.equal(result.customer,value.customer);invoiceOrigin(result);assert.ok(!result.subscription&&result.parent?.type!=='subscription_details');exactLine(result);}
  if(reservation)await m('recordCollection',{token:f.adapter,id:reservation,providerRef:result.id});
  const receipt=await h('reconcile',{token:f.adapter,id,...claim,providerRef:result.id,usage:0});assert.equal(receipt.accepted,true);
  return{result,operation:id,receipt};
 }
 async function observe(name,invoiceId,eventId,digest,validateInvoice){
  const f=fixture[name];
  const scope={token:f.adapter,binding:f.binding,externalId:invoiceId};
  // Close capacity before the first provider read; any failed or partial pull stays closed.
  const epoch=await m('reconcileAdjustments',{...scope,complete:false,refundedMinor:0,creditedMinor:0,receipts:[]});
  const invoice=await stripe.request('GET','/v1/invoices/'+invoiceId,{},f.key.account);assert.equal(invoice.livemode,false);
  validateInvoice?.(invoice);
  const adjustment=await pullAdjustments(stripe,invoice,f.key.account,validateInvoice);
  const inserted=await m('observe',{...scope,reconciliationEpoch:epoch,amountMinor:invoice.total,eventId,digest,state:invoice.status,paidMinor:invoice.amount_paid,refundedMinor:adjustment.refundedMinor,currency:invoice.currency});
  if(!inserted)throw Error('Repeated reconciliation observation; fresh pull identity required');
  await m('reconcileAdjustments',{...scope,complete:true,epoch,refundedMinor:adjustment.refundedMinor,creditedMinor:adjustment.creditedMinor,receipts:adjustment.receipts});
  return{inserted,invoice:{id:invoice.id,status:invoice.status,paidMinor:invoice.amount_paid,remainingMinor:invoice.amount_remaining,totalMinor:invoice.total,currency:invoice.currency,refundedMinor:adjustment.refundedMinor,creditMinor:adjustment.creditedMinor},intents:adjustment.intents};
 }

 return{execute,observe};
}
