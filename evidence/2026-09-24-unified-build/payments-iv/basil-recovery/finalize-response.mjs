import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConvexHttpClient} from 'convex/browser';
import {api} from '../../../../proofs/payments/convex/_generated/api.js';
import {withPayments} from '../../../../proofs/payments/local.mjs';
import {trustedAdapter} from '../../../../proofs/payments/adapter.mjs';
import {CUSTOMERS,CONTINUATION_ID,FIRST_RUN} from '../../../../proofs/payments/continuation.mjs';
import {claimRecovery,checkLocalRecovery,checkRecoveryProvider,completeDraft,RECOVERED_INVOICE} from '../../../../proofs/payments/recovery.mjs';
import {SANDBOX_APPLICATION} from '../../../../proofs/payments/invoice-contract.mjs';
const results=[],secrets=[],digest=x=>createHash('sha256').update(x).digest('hex');
await withPayments(async({url,run})=>{
 const client=new ConvexHttpClient(url,{logger:false}),m=(n,a)=>client.mutation(api.payments[n],a),q=(n,a)=>client.query(api.payments[n],a),tokens=Array.from({length:10},()=>randomUUID());secrets.push(...tokens);
 const f=run('harness:seed',{run:randomUUID(),tokens});
 for(const name of ['A','B']){run('payments:configureFixture',{binding:f[name].binding,adapterToken:f[name].adapter,account:CUSTOMERS[name].account,environment:'SANDBOX',healthy:true});f[name].key={provider:'stripe',environment:'SANDBOX',account:CUSTOMERS[name].account};}
 const customer=await m('registerCustomer',{token:f.A.adapter,binding:f.A.binding,externalId:CUSTOMERS.A.customer,name:'Synthetic P4 customer A'}),quote=await m('createQuote',{token:f.A.sessions.owner,customer,amountMinor:10003,currency:'usd'}),acceptance=await client.action(api.payments.issueAcceptance,{token:f.A.sessions.owner,id:quote,expires:Date.now()+60000});await m('acceptQuote',{id:quote,...acceptance});
 const document=await m('prepareDeposit',{token:f.A.sessions.owner,quote,amountMinor:3001,currency:'usd'});
 const invoice={id:RECOVERED_INVOICE,customer:CUSTOMERS.A.customer,livemode:false,status:'draft',collection_method:'send_invoice',auto_advance:false,currency:'usd',total:0,amount_due:0,amount_paid:0,amount_remaining:0,starting_balance:0,amount_overpaid:0,pre_payment_credit_notes_amount:0,post_payment_credit_notes_amount:0,issuer:{type:'self'},application:SANDBOX_APPLICATION,parent:null,lines:{data:[],has_more:false},metadata:{remold_fixture:CONTINUATION_ID},hosted_invoice_url:'https://invoice.stripe.com/i/acct_synthetic/test'};
 const posts=[],receipts=[];let mode='clean';
 const server=createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost'),path=u.pathname;let body='';for await(const chunk of req)body+=chunk;const params=Object.fromEntries(new URLSearchParams(body));let value;
  if(req.method==='POST'){posts.push({path,key:req.headers['idempotency-key']});if(path==='/v1/invoices'){invoice.metadata.remold_command=params['metadata[remold_command]'];value=invoice;}else if(path==='/v1/invoiceitems'){invoice.total=invoice.amount_due=invoice.amount_remaining=Number(params.amount);invoice.lines.data=[{amount:invoice.total}];value={id:'ii_synthetic'};}else if(path.endsWith('/finalize')){invoice.status='open';value={...invoice,application_fee_amount:7};}else{res.writeHead(400).end('{}');return;}}
  else if(path.startsWith('/v1/accounts/'))value={charges_enabled:true,capabilities:{card_payments:'active'},requirements:{disabled_reason:null,currently_due:[]}};
  else if(path===('/v1/invoices/'+RECOVERED_INVOICE))value={...invoice,...(mode==='line'?{lines:{data:[{id:'il_existing'}],has_more:false}}:{})};
  else if(path.endsWith('/cash_balance'))value={customer:path.split('/')[3],livemode:false,available:null};
  else if(path.startsWith('/v1/customers/')&&!path.endsWith('/balance_transactions')){const id=path.split('/')[3],name=id===CUSTOMERS.A.customer?'A':'B';value={id,livemode:false,name:'Synthetic P4 customer '+name,email:'p4-'+FIRST_RUN+'-'+name.toLowerCase()+'@remold.invalid',balance:0,metadata:{remold_fixture:FIRST_RUN}};}
  else{const owns=u.searchParams.get('customer')===CUSTOMERS.A.customer;value={data:path==='/v1/invoices'&&owns?(mode==='zero'?[]:mode==='two'?[invoice,{id:'in_other'}]:[invoice]):mode===path?[{id:'existing'}]:[],has_more:false};}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const stripe={receipts,request:async(method,path,params={},account,key)=>{const u=new URL(path,'http://127.0.0.1:'+server.address().port);if(method==='GET')u.search=new URLSearchParams(params);const response=await fetch(u,{method,headers:{...(account?{'Stripe-Account':account}:{}),...(key?{'Idempotency-Key':key}:{})},...(method==='POST'?{body:new URLSearchParams(params)}:{})});const value=await response.json();assert.equal(response.status,200);receipts.push({method,path,httpStatus:200,requestId:'req_local_'+receipts.length,account});return value;}};
 const directory=mkdtempSync(join(tmpdir(),'remold-recovery-'));
 try{
  const adapter=trustedAdapter(stripe,client,f),created=await adapter.execute('A',document,{customer:CUSTOMERS.A.customer,collection_method:'send_invoice',days_until_due:30,auto_advance:false,pending_invoice_items_behavior:'exclude','metadata[remold_fixture]':CONTINUATION_ID},'POST','/v1/invoices',{stage:'deposit-create'});await m('attachProvider',{token:f.A.adapter,id:document,externalId:created.result.id});
  const key=posts[0].key;secrets.push(key);const write=(sequence,path,account,idempotencyKey)=>({kind:'write-attempt',sequence,method:'POST',path,account,idempotencyKey,idempotencyDigest:digest(idempotencyKey),payloadDigest:'same-synthetic-payload'});
  const parent=[{kind:'started',id:CONTINUATION_ID,sourceAggregate:'3f2328e9e2c936b9258d47edbc7b1047c16a9f0acd2dd6df2402762efbceb7dd'},{kind:'local-fixture',fixture:f},write(1,'/v1/customers/'+CUSTOMERS.A.customer,CUSTOMERS.A.account,'email-a'),{kind:'write-response',sequence:1,objectId:CUSTOMERS.A.customer,receipt:{httpStatus:200}},write(2,'/v1/customers/'+CUSTOMERS.B.customer,CUSTOMERS.B.account,'email-b'),{kind:'write-response',sequence:2,objectId:CUSTOMERS.B.customer,receipt:{httpStatus:200}},write(3,'/v1/invoices',CUSTOMERS.A.account,key),{kind:'write-error',sequence:3,receipt:{httpStatus:200},outcome:'unknown'},write(4,'/v1/invoices',CUSTOMERS.A.account,key),{kind:'write-response',sequence:4,objectId:RECOVERED_INVOICE,receipt:{httpStatus:200}}];
  const parentPath=join(directory,CONTINUATION_ID+'.jsonl'),pinPath=join(directory,'basil-recovery-parent.json'),raw=parent.map(JSON.stringify).join('\n')+'\n';const saveParent=(text,pin=true)=>{writeFileSync(parentPath,text,{mode:0o600});if(pin)writeFileSync(pinPath,JSON.stringify({journalSha256:digest(text)}),{mode:0o600});};saveParent(raw);
  const options={privateDirectory:directory,sourceAggregate:'synthetic-successor'};
  saveParent(raw+'\n',false);assert.throws(()=>claimRecovery(options),/Parent journal digest/);saveParent(raw);results.push('Changed parent bytes refuse recovery before requests');
  saveParent(raw+JSON.stringify(write(5,'/v1/payment_intents',CUSTOMERS.A.account,'unexpected'))+'\n');assert.throws(()=>claimRecovery(options),/write count/);saveParent(raw);results.push('Unexpected parent write refuses even when a supplied digest matches');
  const recovery=claimRecovery(options);const before=receipts.length;assert.throws(()=>claimRecovery(options),/EEXIST/);assert.equal(receipts.length,before);results.push('Spent recovery latch refuses before provider calls');
  const finance=await q('exportFinance',{token:f.A.sessions.owner}),operations=run('paymentFixture:recoveryOperations',{org:f.A.org}),restored=checkLocalRecovery(finance,operations,recovery);assert.equal(restored.deposit,document);assert.equal(restored.quote,quote);
  for(const change of [x=>x.documents[0].externalId='in_other',x=>x.documents[0].paidMinor=1,x=>x.quotes[0].version=2]){const bad=structuredClone(finance);change(bad);assert.throws(()=>checkLocalRecovery(bad,operations,recovery));}
  assert.throws(()=>checkLocalRecovery(finance,operations.map(o=>({...o,state:'outcomeUnknown'})),recovery));assert.throws(()=>checkLocalRecovery(finance,[...operations,{org:f.A.org,logical:document+':POST:deposit-item'}],recovery));results.push('Changed document, quote, unresolved create or later local operation refuses recovery');
  const wrapped=recovery.journal.wrap(stripe),writesBefore=posts.length;
  for(const dirty of ['zero','two','line','/v1/invoiceitems','/v1/payment_intents','/v1/charges','/v1/subscriptions']){mode=dirty;await assert.rejects(checkRecoveryProvider(wrapped,recovery.journal,restored.createCommand));assert.equal(posts.length,writesBefore);}
  mode='clean';await checkRecoveryProvider(wrapped,recovery.journal,restored.createCommand);results.push('Provider missing/duplicate draft, existing line/item/payment/charge/subscription refuses with zero writes');
  const recoveredAdapter=trustedAdapter(wrapped,client,recovery.fixture);
  await assert.rejects(completeDraft({adapter:recoveredAdapter,document,invoice:RECOVERED_INVOICE,label:'deposit',customer:CUSTOMERS.A.customer,amountMinor:3001,currency:'usd',bindPaymentPage:url=>m('bindPaymentPage',{token:f.A.adapter,id:document,url}),pull:invoice=>recoveredAdapter.observe('A',invoice,randomUUID(),randomUUID())}),/Explicit invoice fee unsupported/);
  assert.deepEqual(posts.slice(writesBefore).map(p=>p.path),['/v1/invoiceitems','/v1/invoices/'+RECOVERED_INVOICE+'/finalize']);
  const operationsAfter=run('paymentFixture:recoveryOperations',{org:f.A.org});
  const finalOp=operationsAfter.find(o=>o.logical.endsWith('/finalize'));assert.ok(finalOp);assert.notEqual(finalOp.state,'confirmed');assert.equal(finalOp.receipts.length,0);
  const journalRows=readFileSync(recovery.journal.path,'utf8').trim().split('\n').map(JSON.parse);assert.equal(journalRows.filter(r=>r.kind==='write-response').length,2);assert.equal(journalRows.at(-1).objectId,RECOVERED_INVOICE);
  assert.throws(()=>claimRecovery(options),/EEXIST/);
  results.push({name:'Independent clean pre-read then explicit fee only in finalize response',providerFinalizeWrites:1,itemWrites:1,finalState:finalOp.state,confirmedReceipts:0,durableProviderResponse:true,restartRefused:true,classification:'Post-effect refusal, not pre-write refusal'});
 }finally{await new Promise(r=>server.close(r));rmSync(directory,{recursive:true,force:true});}
});
const output=JSON.stringify({level:'SERVICE local Convex and loopback HTTP; parent journal and provider objects synthetic; no Stripe calls',results},null,2)+'\n';for(const secret of secrets)assert.ok(!output.includes(secret),'Secret in public recovery evidence');writeFileSync(new URL('./finalize-response.json',import.meta.url),output);console.log(JSON.stringify({passed:results.length,secretOutputCheck:true}));
