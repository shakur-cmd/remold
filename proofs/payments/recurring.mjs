import assert from 'node:assert/strict';
export async function recurring({stripe,adapter,m,q,h,f,runId,run,check,objects}){
 const account=f.A.key.account,owner=f.A.sessions.owner,initialTime=Math.floor(Date.now()/1000);
 const clock=await stripe.request('POST','/v1/test_helpers/test_clocks',{frozen_time:initialTime,name:'Synthetic P4 recurring fixture'},account,runId+'-clock');
 const product=await stripe.request('POST','/v1/products',{name:'Synthetic P4 monthly service'},account,runId+'-product');
 const price=await stripe.request('POST','/v1/prices',{product:product.id,unit_amount:1111,currency:'usd','recurring[interval]':'month'},account,runId+'-price');
 const customer=await stripe.request('POST','/v1/customers',{name:'Synthetic recurring customer',test_clock:clock.id,payment_method:'pm_card_visa','invoice_settings[default_payment_method]':'pm_card_visa'},account,runId+'-clock-customer');
 const localCustomer=await m('registerCustomer',{token:f.A.adapter,binding:f.A.binding,externalId:customer.id,name:'Synthetic recurring customer'});
 const doc=await m('prepareInvoice',{token:owner,customer:localCustomer,amountMinor:1111,currency:'usd',kind:'recurring'});
 const {result:subscription}=await adapter.execute('A',doc,{customer:customer.id,'items[0][price]':price.id,payment_behavior:'error_if_incomplete'},'POST','/v1/subscriptions');
 assert.equal(subscription.application_fee_percent,null);assert.equal(subscription.status,'active');
 await m('attachProvider',{token:f.A.adapter,id:doc,externalId:subscription.latest_invoice});
 await m('bindSafetyReference',{token:f.A.adapter,id:doc,subscription:subscription.id});
 await adapter.observe('A',subscription.latest_invoice,'pull-first-sub','pull-first-sub');
 objects.push({kind:'recurring',account,id:subscription.id,clock:clock.id,document:doc,amountMinor:1111});
 const observe=async(label)=>{
  const current=await stripe.request('GET','/v1/subscriptions/'+subscription.id,{},account);
  const invoice=await stripe.request('GET','/v1/invoices/'+current.latest_invoice,{},account);
  const args={token:f.A.adapter,parent:doc,subscription:subscription.id,invoice:invoice.id,amountMinor:invoice.total,currency:invoice.currency,paidMinor:invoice.amount_paid,state:invoice.status,eventId:'pull-'+label,digest:'pull-'+label};
  const first=await m('observeRenewal',args),second=await m('observeRenewal',args);assert.equal(first,second);
  await m('observeService',{token:f.A.adapter,id:doc,subscription:subscription.id,status:current.status});
  return{current,invoice,document:first};
 };
 const advance=async(time)=>{
  await stripe.request('POST','/v1/test_helpers/test_clocks/'+clock.id+'/advance',{frozen_time:time},account,runId+'-advance-'+time);
  for(let attempt=0;attempt<45;attempt++){const value=await stripe.request('GET','/v1/test_helpers/test_clocks/'+clock.id,{},account);if(value.status==='ready')return;await new Promise(r=>setTimeout(r,1000));}
  throw Error('Test clock did not become ready');
 };
 const periodEnd=s=>s.items.data[0].current_period_end;
 await h('control',{token:owner,readonly:true});const before=run('paymentFixture:counts',{org:f.A.org});
 await advance(periodEnd(subscription)+7200);
 let renewed=await observe('renewed');
 // Clock invoice finalization can wait one further hour after invoice creation.
 if(renewed.invoice.status!=='paid'){await advance(periodEnd(subscription)+14400);renewed=await observe('renewed-final');}
 await check('Already-authorized merchant renewal continues in readonly without a new Remold operation',async()=>{assert.equal(renewed.invoice.status,'paid');assert.equal(renewed.invoice.amount_paid,1111);assert.notEqual(renewed.invoice.id,subscription.latest_invoice);assert.equal(run('paymentFixture:counts',{org:f.A.org}).operations,before.operations);});
 // This only changes the synthetic provider fixture card; it is not a Remold-triggered retry.
 const failedPm=await stripe.request('POST','/v1/payment_methods/pm_card_chargeCustomerFail/attach',{customer:customer.id},account,runId+'-failing-card');
 await stripe.request('POST','/v1/customers/'+customer.id,{'invoice_settings[default_payment_method]':failedPm.id},account,runId+'-set-failing-card');
 const failureEnd=periodEnd(renewed.current);await advance(failureEnd+14400);let failure=await observe('failed-renewal');
 if(failure.current.status!=='past_due'){await advance(failureEnd+18000);failure=await observe('failed-renewal-final');}
 await check('Failed renewal exposes unpaid amount and past-due service while readonly',async()=>{assert.equal(failure.current.status,'past_due');assert.equal(failure.invoice.amount_paid,0);assert.equal(failure.invoice.amount_remaining,1111);assert.equal((await q('getDocument',{token:owner,id:doc})).subscriptionStatus,'past_due');});
 const good=await stripe.request('POST','/v1/payment_methods/pm_card_visa/attach',{customer:customer.id},account,runId+'-updated-card');
 await stripe.request('POST','/v1/customers/'+customer.id,{'invoice_settings[default_payment_method]':good.id},account,runId+'-set-updated-card');
 await h('control',{token:owner,readonly:false});
 await adapter.execute('A',failure.document,{payment_method:good.id},'POST','/v1/invoices/'+failure.invoice.id+'/pay');
 const recovered=await observe('card-updated');
 await check('Card update followed by authorized retry recovers the exact failed invoice',async()=>{assert.equal(recovered.invoice.id,failure.invoice.id);assert.equal(recovered.invoice.status,'paid');assert.equal(recovered.invoice.amount_paid,1111);assert.equal(recovered.current.status,'active');});
 await h('control',{token:owner,readonly:true});
 const id=await m('prepareSafety',{token:owner,document:doc,binding:f.A.binding,destination:account,action:'cancel',amountMinor:0,logical:runId+'-cancel-service'});
 const permit=await m('permitSafety',{token:f.A.adapter,id});
 const canceled=await stripe.request('DELETE','/v1/subscriptions/'+permit.subscription,{invoice_now:false,prorate:false},permit.account,permit.key);
 assert.equal(canceled.status,'canceled');await m('observeService',{token:f.A.adapter,id:doc,subscription:subscription.id,status:canceled.status});await m('settleSafety',{token:f.A.adapter,id,providerRef:canceled.id});
 const beforeCancel=await stripe.request('GET','/v1/invoices',{customer:customer.id,limit:100},account);
 await advance(periodEnd(recovered.current)+14400);
 await check('Readonly client cancellation stops next renewal without changing the platform account',async()=>{const after=await stripe.request('GET','/v1/invoices',{customer:customer.id,limit:100},account);assert.deepEqual(after.data.map(i=>i.id),beforeCancel.data.map(i=>i.id));assert.equal((await q('getDocument',{token:owner,id:doc})).subscriptionStatus,'canceled');});
 await h('control',{token:owner,readonly:false});
 const replacementDoc=await m('prepareInvoice',{token:owner,customer:localCustomer,amountMinor:1111,currency:'usd',kind:'recurring'});
 const {result:replacement}=await adapter.execute('A',replacementDoc,{customer:customer.id,'items[0][price]':price.id,payment_behavior:'error_if_incomplete'},'POST','/v1/subscriptions');
 await m('attachProvider',{token:f.A.adapter,id:replacementDoc,externalId:replacement.latest_invoice});
 await m('bindSafetyReference',{token:f.A.adapter,id:replacementDoc,subscription:replacement.id});
 await m('observeService',{token:f.A.adapter,id:replacementDoc,subscription:replacement.id,status:replacement.status});
 await check('Old canceled subscription identity cannot overwrite a newly authorized service',async()=>{
  await assert.rejects(m('observeService',{token:f.A.adapter,id:replacementDoc,subscription:subscription.id,status:'canceled'}),/subscription binding mismatch/);
  const old=await stripe.request('GET','/v1/subscriptions/'+subscription.id,{},account);
  await m('observeService',{token:f.A.adapter,id:doc,subscription:old.id,status:old.status});
  assert.equal((await q('getDocument',{token:owner,id:replacementDoc})).subscriptionStatus,'active');
 });
 objects.push({kind:'replacement-recurring',account,id:replacement.id,previous:subscription.id,document:replacementDoc});
}
