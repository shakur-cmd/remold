import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync} from 'node:fs';
import {ConvexHttpClient} from 'convex/browser';
import {api} from './convex/_generated/api.js';
import {withPayments} from './local.mjs';
import {provider,credentials,API_VERSION,OutcomeUnknown} from './stripe.mjs';
import {trustedAdapter} from './adapter.mjs';
import {listen} from './webhooks.mjs';
import {recurring} from './recurring.mjs';
import {boundary} from './boundary.mjs';
import {invoiceOrigin,proveNoPlatformFee} from './invoice-contract.mjs';
import {claimRecovery,checkLocalRecovery,checkRecoveryProvider,completeDraft,RECOVERY_ID,RECOVERED_INVOICE} from './recovery.mjs';
import {claimContinuation,checkCustomers,setCustomerEmails,CUSTOMERS,CONTINUATION_ID,FIRST_RUN,FIRST_ATTEMPT_SHA} from './continuation.mjs';
const args=process.argv.slice(2);assert.ok(args.length===0||(args.length===1&&['--continue-first-enabled-attempt','--recover-existing-draft'].includes(args[0])),'Unsupported sandbox invocation');
const continuing=args[0]==='--continue-first-enabled-attempt',recovering=args[0]==='--recover-existing-draft';
let journal,recovery;
if(continuing||recovering){
 const manifest=JSON.parse(readFileSync(new URL('./evidence/source-manifest.json',import.meta.url)));
 for(const[file,hash]of Object.entries(manifest.files))assert.equal(createHash('sha256').update(readFileSync(new URL(file,import.meta.url))).digest('hex'),hash,'Unfrozen continuation source');
 const directories={privateDirectory:fileURLToPath(new URL('./private/',import.meta.url)),evidenceDirectory:fileURLToPath(new URL('./evidence/',import.meta.url)),sourceAggregate:manifest.aggregateSha256};
 if(recovering){recovery=claimRecovery(directories);journal=recovery.journal;}else journal=claimContinuation(directories);
}
const rawStripe=provider(credentials()),stripe=journal?journal.wrap(rawStripe):rawStripe,guard=await stripe.verify(),runId=continuing||recovering?CONTINUATION_ID:randomUUID(),outputId=recovering?RECOVERY_ID:runId;
const merchantFixtures=Object.fromEntries(Object.entries({A:'D',B:'E'}).map(([tenant,label])=>{
 const receipt=JSON.parse(readFileSync(new URL('./evidence/oauth-'+label+'.json',import.meta.url)));
 assert.equal(receipt.fixture,label);assert.equal(receipt.oauthLivemode,false);assert.equal(receipt.scope,'read_write');assert.match(receipt.account,/^acct_[A-Za-z0-9]+$/);
 return[tenant,{fixture:label,account:receipt.account}];
}));
assert.notEqual(merchantFixtures.A.account,merchantFixtures.B.account,'Two distinct OAuth test merchants required');
if(continuing||recovering)for(const name of ['A','B'])assert.equal(merchantFixtures[name].account,CUSTOMERS[name].account,'Continuation merchant mismatch');
const results=[],objects=[],webhookReceipts=[],feeEvidence=[];
const proof={...(continuing||recovering?{continuationOf:FIRST_RUN,firstAttemptSha:FIRST_ATTEMPT_SHA}:{}),...(recovering?{recoveryOf:CONTINUATION_ID,recoveryId:RECOVERY_ID,comparisonWindow:'recovery only'}:{}),level:'SANDBOX Stripe, SERVICE disposable local Convex, SIM identities/prices/jurisdiction',runId,apiVersion:API_VERSION,guard,merchantFixtures,results,objects,receipts:stripe.receipts,webhookReceipts,feeEvidence};
const save=()=>writeFileSync(new URL(continuing||recovering?'./evidence/sandbox-'+outputId+'.json':'./evidence/sandbox.json',import.meta.url),JSON.stringify(proof,null,2)+'\n');
const check=async(name,fn)=>{await fn();results.push({name,status:'PASS'});save();console.log('PASS '+name);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const noFee=async(pi,account,customer,amountMinor)=>{try{feeEvidence.push(await proveNoPlatformFee(stripe,{paymentIntent:pi.id,account,customer,amountMinor}));save();}catch(error){feeEvidence.push({paymentIntent:pi.id,account,status:error.evidenceStatus??'FAIL'});save();throw error;}};
try{
 await withPayments(async({url,run})=>{
  const client=new ConvexHttpClient(url,{logger:false}),f=recovering?recovery.fixture:run('harness:seed',{run:runId,tokens:Array.from({length:10},()=>randomUUID())});
  const m=(name,args)=>client.mutation(api.payments[name],args),q=(name,args)=>client.query(api.payments[name],args),h=(name,args)=>client.mutation(api.harness[name],args);
  for(const name of ['A','B']){
   const account=await stripe.request('GET','/v1/accounts/'+merchantFixtures[name].account);
   assert.equal(account.id,merchantFixtures[name].account);assert.equal(account.charges_enabled,true,'Healthy OAuth sandbox merchant required: '+name);
   assert.equal(account.payouts_enabled,true);assert.equal(account.capabilities?.card_payments,'active');assert.equal(account.requirements?.disabled_reason,null);
   for(const field of ['currently_due','past_due','pending_verification','errors'])assert.deepEqual(account.requirements?.[field],[],'Unresolved account requirement: '+field);
   assert.equal(account.type,'standard');assert.equal(account.controller.requirement_collection,'stripe');assert.equal(account.controller.fees?.payer,'account');assert.equal(account.controller.losses?.payments,'stripe');assert.equal(account.controller.stripe_dashboard?.type,'full');
   const balance=await stripe.request('GET','/v1/balance',{},account.id);assert.equal(balance.livemode,false);
   if(!recovering)run('payments:configureFixture',{binding:f[name].binding,adapterToken:f[name].adapter,account:account.id,environment:'SANDBOX',healthy:true});f[name].key={provider:'stripe',environment:'SANDBOX',account:account.id};
   if(!recovering)run('paymentFixture:role',{actor:f[name].actors.owner,role:'finance'});
  }
  if(!recovering)journal?.append({kind:'local-fixture',fixture:f});
  const restored=recovering?checkLocalRecovery(await q('exportFinance',{token:f.A.sessions.owner}),run('paymentFixture:recoveryOperations',{org:f.A.org}),recovery):null;
  const adapter=trustedAdapter(stripe,client,f),owner=f.A.sessions.owner;
  // Each provider read is a new reconciliation attempt, separate from webhook deduplication.
  const pull=(invoice,label)=>adapter.observe('A',invoice,runId+':pull:'+label+':'+randomUUID(),randomUUID());
  let listener=await listen(credentials(),async(event,digest)=>{
   const name=['A','B'].find(n=>f[n].key.account===event.account);
   if(!name)return;
   const account=f[name];await m('ingest',{token:account.adapter,binding:account.binding,eventId:event.id,type:event.type,externalId:event.data.object.id,digest});
  });
  try{
   if(recovering)await checkRecoveryProvider(stripe,journal,restored.createCommand);
   if(continuing){const snapshot=await checkCustomers(stripe,journal);await setCustomerEmails(stripe,journal,snapshot);}
   for(const name of ['A','B']){
    if(continuing||recovering)assert.equal(f[name].key.account,CUSTOMERS[name].account);
    const c=continuing||recovering?{id:CUSTOMERS[name].customer}:await stripe.request('POST','/v1/customers',{name:'Synthetic P4 customer '+name,'metadata[remold_fixture]':runId},f[name].key.account,runId+'-customer-'+name);
    f[name].customer=c.id;f[name].localCustomer=recovering?(name==='A'?restored.localCustomer:undefined):await m('registerCustomer',{token:f[name].adapter,binding:f[name].binding,externalId:c.id,name:'Synthetic P4 customer '+name});objects.push({kind:'customer',account:f[name].key.account,id:c.id});
   }
   const bBefore=await q('exportFinance',{token:f.B.sessions.owner});
   const platformBefore=await stripe.request('GET','/v1/payment_intents',{limit:100});
   let quote,deposit;
   if(recovering){quote=restored.quote;deposit=restored.deposit;}else{
   quote=await m('createQuote',{token:owner,customer:f.A.localCustomer,amountMinor:10003,currency:'usd'});
   const link=await client.action(api.payments.issueAcceptance,{token:owner,id:quote,expires:Date.now()+60000});
   await m('acceptQuote',{id:quote,...link});
   deposit=await m('prepareDeposit',{token:owner,quote,amountMinor:3001,currency:'usd'});
   }
   const issue=async(document,label)=>{
    const d=await q('getDocument',{token:owner,id:document});
    let invoice;
    if(recovering&&document===restored.deposit){assert.equal(label,'deposit');invoice={id:RECOVERED_INVOICE};}else{
    ({result:invoice}=await adapter.execute('A',document,{customer:f.A.customer,collection_method:'send_invoice',days_until_due:30,auto_advance:false,pending_invoice_items_behavior:'exclude','metadata[remold_fixture]':runId},'POST','/v1/invoices',{stage:label+'-create',timeout:true}));
    await m('attachProvider',{token:f.A.adapter,id:document,externalId:invoice.id});
    }
    const finalized=await completeDraft({adapter,document,invoice:invoice.id,label,customer:f.A.customer,amountMinor:d.amountMinor,currency:d.currency,bindPaymentPage:url=>m('bindPaymentPage',{token:f.A.adapter,id:document,url}),pull});
    objects.push({kind:label,document,account:f.A.key.account,id:invoice.id,amountMinor:d.amountMinor,...invoiceOrigin(finalized)});return invoice.id;
   };
   const pay=async(document,invoice,amount,stage,pm='pm_card_visa')=>{
    const {result:pi}=await adapter.execute('A',document,{customer:f.A.customer,amount,currency:'usd',payment_method:pm,'payment_method_types[]':'card',confirm:true,'metadata[remold_fixture]':runId},'POST','/v1/payment_intents',{stage});
    assert.equal(pi.livemode,false);assert.equal(pi.status,'succeeded');await noFee(pi,f.A.key.account,f.A.customer,amount);
    await adapter.execute('A',document,{payment_intent:pi.id},'POST','/v1/invoices/'+invoice+'/attach_payment',{stage:stage+'-attach'});
    objects.push({kind:'payment',account:f.A.key.account,id:pi.id,invoice,amountMinor:amount});return pi;
   };
   const invoice=await issue(deposit,'deposit');
   await check('Actual hosted invoice payment page is returned only by its scoped unexpired capability',async()=>{
    const capability=await client.action(api.payments.issuePaymentLink,{token:owner,id:deposit,expires:Date.now()+60000});
    const one=await q('publicPayment',{token:capability.token}),two=await q('publicPayment',{token:capability.token});assert.ok(one.url===two.url);assert.equal(new URL(one.url).origin,'https://invoice.stripe.com');assert.equal(one.amountMinor,3001);
    await assert.rejects(q('publicPayment',{token:capability.token+'tamper'}),/invalid or expired/);
    await assert.rejects(m('observe',{token:owner,binding:f.A.binding,externalId:invoice,eventId:'browser-paid-redirect',digest:'forged',state:'paid',paidMinor:3001,refundedMinor:0,currency:'usd'}),/adapter account denied/);
    assert.equal((await q('getDocument',{token:owner,id:deposit})).paidMinor,0);
   });
   const pi=await pay(deposit,invoice,3001,'deposit-pay');
   await m('bindSafetyReference',{token:f.A.adapter,id:deposit,paymentIntent:pi.id,charge:pi.latest_charge});
   await check('Deposit paid once in merchant A with exact 3001 minor units and no platform fee',async()=>{const observed=await pull(invoice,'pull-deposit');assert.equal(observed.invoice.paidMinor,3001);assert.equal(observed.invoice.status,'paid');});
   const balances=await Promise.all([1,2].map(()=>m('prepareBalance',{token:owner,quote})));assert.equal(balances[0],balances[1]);
   const balance=balances[0],balanceInvoice=await issue(balance,'balance');
   await pay(balance,balanceInvoice,2000,'balance-partial');
   await check('Partial payment remains open and one deposit allocation preserves quote total',async()=>{const v=await pull(balanceInvoice,'pull-partial');assert.equal(v.invoice.paidMinor,2000);assert.equal(v.invoice.remainingMinor,5002);assert.equal(v.invoice.status,'open');assert.equal(v.invoice.totalMinor+3001,10003);});
   await pay(balance,balanceInvoice,5002,'balance-rest');
   await pull(balanceInvoice,'pull-paid');
   await check('Foreign account customer and invoice references are rejected by provider and tenant boundary',async()=>{
    await assert.rejects(stripe.request('GET','/v1/invoices/'+invoice,{},f.B.key.account),e=>e.status===404);
    await assert.rejects(stripe.request('POST','/v1/invoices',{customer:f.B.customer,auto_advance:false},f.A.key.account,runId+'-foreign-customer'),e=>e.status===400);
    await assert.rejects(q('getDocument',{token:f.B.sessions.owner,id:deposit}),/tenant denied/);
   });
   const voidDoc=await m('prepareInvoice',{token:owner,customer:f.A.localCustomer,amountMinor:777,currency:'usd',kind:'invoice'}),voidInvoice=await issue(voidDoc,'void');
   const lifecycle=async(document,action,amountMinor)=>{const documentValue=await q('getDocument',{token:owner,id:document});await pull(documentValue.externalId,'before-lifecycle-'+document);const id=await m('prepareLifecycle',{token:owner,document,action,amountMinor}),permit=await m('permitLifecycle',{token:f.A.adapter,id});const result=await stripe.request('POST',permit.action==='void'?'/v1/invoices/'+permit.invoice+'/void':'/v1/credit_notes',permit.action==='void'?{}:{invoice:permit.invoice,amount:permit.amountMinor,email_type:'none','metadata[remold_operation]':id},permit.account,permit.key);if(permit.action==='credit'){assert.equal(result.invoice,permit.invoice);assert.equal(result.amount,permit.amountMinor);assert.equal(result.currency,documentValue.currency);assert.equal(result.status,'issued');}else assert.equal(result.id,permit.invoice);await m('settleLifecycle',{token:f.A.adapter,id,providerRef:result.id,...(permit.action==='credit'?{receipt:{kind:'credit',receiptId:result.id,sourceRef:permit.invoice,operationId:id,amountMinor:result.amount,status:'succeeded'}}:{})});return result;};
   const voided=await lifecycle(voidDoc,'void',0);assert.equal(voided.status,'void');
   const creditDoc=await m('prepareInvoice',{token:owner,customer:f.A.localCustomer,amountMinor:999,currency:'usd',kind:'invoice'}),creditInvoice=await issue(creditDoc,'credit');
   const credit=await lifecycle(creditDoc,'credit',99);
   await check('Actual void and credit note preserve original invoice amount and explain adjustment',async()=>{assert.equal(credit.amount,99);const v=await pull(creditInvoice,'pull-credit');assert.equal(v.invoice.totalMinor,999);assert.equal(v.invoice.remainingMinor,900);assert.equal(v.invoice.creditMinor,99);});
   await h('control',{token:owner,readonly:true});
   const safety=await m('prepareSafety',{token:owner,document:deposit,binding:f.A.binding,destination:f.A.key.account,action:'refund',amountMinor:101,logical:runId+'-refund'});
   const permit=await m('permitSafety',{token:f.A.adapter,id:safety});
   await assert.rejects(stripe.request('POST','/v1/refunds',{payment_intent:permit.paymentIntent,amount:permit.amountMinor,'metadata[remold_operation]':safety},permit.account,permit.key,{loseResponse:true}),OutcomeUnknown);
   const matchingRefunds=await stripe.request('GET','/v1/refunds',{payment_intent:permit.paymentIntent,limit:100},permit.account);
   assert.equal(matchingRefunds.has_more,false);const candidates=matchingRefunds.data.filter(r=>r.metadata.remold_operation===safety);assert.equal(candidates.length,1);const refund=candidates[0];
   const repeated=await stripe.request('POST','/v1/refunds',{payment_intent:permit.paymentIntent,amount:permit.amountMinor,'metadata[remold_operation]':safety},permit.account,permit.key);assert.equal(repeated.id,refund.id);
   assert.equal(refund.status,'succeeded');assert.equal(refund.amount,permit.amountMinor);assert.equal(refund.payment_intent,permit.paymentIntent);assert.equal(refund.currency,permit.currency);await pull(invoice,'pull-refund');await m('settleSafety',{token:f.A.adapter,id:safety,providerRef:refund.id});
   await check('Readonly human safety refund creates one provider refund across timeout lookup and replay',async()=>{const refunds=await stripe.request('GET','/v1/refunds',{payment_intent:pi.id,limit:100},f.A.key.account);assert.equal(refunds.data.length,1);assert.equal(refunds.data[0].amount,101);assert.equal((await q('getDocument',{token:owner,id:deposit})).refundedMinor,101);await assert.rejects(m('createQuote',{token:owner,customer:f.A.localCustomer,amountMinor:5,currency:'usd'}),/readonly/);});
   await h('control',{token:owner,readonly:false});
   results.push(recurring());save();
   await boundary({stripe,client,m,q,h,run,account:f.A.key.account,externalCustomer:f.A.customer,runId,check,objects,noFee});
   const disputeDoc=await m('prepareInvoice',{token:owner,customer:f.A.localCustomer,amountMinor:805,currency:'usd',kind:'invoice'}),disputeInvoice=await issue(disputeDoc,'dispute');
   const disputed=await pay(disputeDoc,disputeInvoice,805,'disputed-payment','pm_card_createDispute');
   await pull(disputeInvoice,'pull-dispute-paid');
   let dispute;for(let attempt=0;attempt<45&&!dispute;attempt++){const list=await stripe.request('GET','/v1/disputes',{payment_intent:disputed.id,limit:10},f.A.key.account);dispute=list.data[0];if(!dispute)await sleep(1000);}
   await check('Provider test dispute exposes exact amount/status on the owning financial document',async()=>{assert.ok(dispute);assert.equal(dispute.amount,805);assert.equal(dispute.payment_intent,disputed.id);await m('observeAdjustment',{token:f.A.adapter,id:disputeDoc,disputeAmountMinor:dispute.amount,disputeStatus:dispute.status});const d=await q('getDocument',{token:owner,id:disputeDoc});assert.equal(d.disputeAmountMinor,805);assert.equal(d.disputeStatus,dispute.status);objects.push({kind:'dispute',account:f.A.key.account,id:dispute.id,amountMinor:dispute.amount,status:dispute.status});});
   // Wait for real provider deliveries; old signed events always trigger current state pulls.
   for(let attempt=0;attempt<30&&!listener.receipts.some(e=>e.type==='invoice.paid');attempt++)await sleep(1000);
   await check('Actual CLI forwarded provider webhook is signed, durably ingested and duplicate-safe',async()=>{
    assert.ok(listener.receipts.some(e=>e.type==='invoice.paid'&&e.account===f.A.key.account));
    const captured=listener.received.find(r=>listener.verify(r.raw,r.signature).type==='invoice.paid');assert.ok(captured);
    const response=await fetch('http://127.0.0.1:3492/stripe',{method:'POST',headers:{'Stripe-Signature':captured.signature},body:captured.raw});assert.equal(response.status,200);
    const tampered=await fetch('http://127.0.0.1:3492/stripe',{method:'POST',headers:{'Stripe-Signature':captured.signature},body:Buffer.concat([captured.raw,Buffer.from(' ' )])});assert.equal(tampered.status,400);
    assert.throws(()=>listener.verify(captured.raw,captured.signature,Date.now()+301000),/timestamp/);
    const pending=await q('pendingEvents',{token:f.A.adapter,binding:f.A.binding});
    const paid=pending.find(e=>e.type==='invoice.paid'&&e.externalId===invoice);assert.ok(paid);
    assert.equal(await m('ingest',{token:f.A.adapter,binding:f.A.binding,eventId:paid.eventId,type:paid.type,externalId:paid.externalId,digest:paid.digest}),false);
    const now=await pull(invoice,'webhook-current');assert.equal(now.invoice.refundedMinor,101);
    assert.equal((await pull(invoice,'webhook-repeat-current')).invoice.refundedMinor,101);
    await m('ackEvent',{token:f.A.adapter,id:paid._id});
   });
   await check('Merchant B financial state and platform collections remain unchanged',async()=>{
    assert.deepEqual(await q('exportFinance',{token:f.B.sessions.owner}),bBefore);
    const platformAfter=await stripe.request('GET','/v1/payment_intents',{limit:100});assert.deepEqual(platformAfter.data.map(p=>p.id),platformBefore.data.map(p=>p.id));
    assert.equal(objects.filter(x=>x.kind==='payment').every(x=>x.account===f.A.key.account),true);
   });
   webhookReceipts.push(...listener.receipts);proof.status=results.some(r=>r.status!=='PASS')?'INCOMPLETE: required recurring activation/retry proof remains blocked':'Builder SANDBOX replay passed; production integration, IV and G-pay remain pending';if(results.some(r=>r.status!=='PASS'))process.exitCode=1;save();
  }finally{webhookReceipts.push(...listener.receipts.filter(x=>!webhookReceipts.some(y=>y.id===x.id)));await listener.stop();}
 });
}catch(error){proof.status='FAILED or BLOCKED';proof.failure={message:error.message,status:error.status??null,code:error.code??null,providerMessage:error.providerMessage?String(error.providerMessage).replace(/(?:sk_test_|rk_test_|whsec_|ac_)[A-Za-z0-9]+/g,'[redacted]'):null};save();console.error(JSON.stringify(proof.failure));process.exitCode=1;}finally{save();journal?.append({kind:'stopped',status:proof.status??'stopped-review',evidence:'sandbox-'+outputId+'.json'});}
