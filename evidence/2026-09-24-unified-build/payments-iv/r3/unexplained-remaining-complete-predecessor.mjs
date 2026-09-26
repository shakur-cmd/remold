import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
import {ConvexHttpClient} from 'convex/browser';
import {api} from '../../../../proofs/payments/convex/_generated/api.js';
import {withPayments} from '../../../../proofs/payments/local.mjs';
import {trustedAdapter} from '../../../../proofs/payments/private/frozen-before-remaining-consistency/adapter.mjs';
const results=[];
await withPayments(async({url,run})=>{
 const c=new ConvexHttpClient(url,{logger:false}),m=(n,a)=>c.mutation(api.payments[n],a);
 for(const remaining of [50,137]){
  const f=run('harness:seed',{run:randomUUID(),tokens:Array.from({length:10},()=>randomUUID())}),token=f.A.adapter,owner=f.A.sessions.owner;
  const customerId='cus_iv_'+randomUUID().replaceAll('-',''),invoiceId='in_iv_'+randomUUID().replaceAll('-','');
  const customer=await m('registerCustomer',{token,binding:f.A.binding,externalId:customerId,name:'IV unexplained remaining'}),document=await m('prepareInvoice',{token:owner,customer,amountMinor:137,currency:'usd',kind:'invoice'});
  await m('attachProvider',{token,id:document,externalId:invoiceId});
  const writes=[];
  const server=createServer(async(req,res)=>{
   const path=new URL(req.url,'http://localhost').pathname;let body='';for await(const chunk of req)body+=chunk;let value;
   if(req.method==='POST'){writes.push({path,amount:Number(new URLSearchParams(body).get('amount'))});value={id:'pi_iv_'+randomUUID().replaceAll('-',''),livemode:false};}
   else if(path.startsWith('/v1/accounts/'))value={charges_enabled:true,capabilities:{card_payments:'active'},requirements:{disabled_reason:null,currently_due:[]}};
   else if(path==='/v1/invoices/'+invoiceId)value={id:invoiceId,customer:customerId,currency:'usd',livemode:false,status:'open',collection_method:'send_invoice',auto_advance:false,application_fee_amount:null,starting_balance:0,amount_overpaid:0,total:137,amount_due:137,amount_paid:0,amount_remaining:remaining,pre_payment_credit_notes_amount:0,post_payment_credit_notes_amount:0,lines:{data:[{amount:137}],has_more:false}};
   else if(path==='/v1/invoice_payments'||path==='/v1/credit_notes')value={data:[],has_more:false};
   else{res.writeHead(404).end('{}');return;}
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const stripe={request:async(method,path,params={},account)=>{if(account)assert.equal(account,f.A.key.account);const u=new URL(path,'http://127.0.0.1:'+server.address().port);if(method==='GET')u.search=new URLSearchParams(params);const response=await fetch(u,{method,...(method==='POST'?{body:new URLSearchParams(params)}:{})});assert.equal(response.status,200);return response.json();}};
  const attempts=[];
  try{const adapter=trustedAdapter(stripe,c,f);for(let n=1;n<=2;n++){
   let refused=false,error=null;
   try{await adapter.execute('A',document,{customer:customerId,amount:37,currency:'usd',payment_method:'pm_iv','payment_method_types[]':'card',confirm:true},'POST','/v1/payment_intents',{stage:'independent-collection-'+n});}catch(e){refused=true;error=e.message;}
   attempts.push({n,refused,error});
  }}finally{await new Promise(r=>server.close(r));}
  const expected=remaining===50?0:2,stored=await c.query(api.payments.getDocument,{token:owner,id:document});
  results.push({obligation:137,paid:0,credits:0,providerRemaining:remaining,attempts,writes,totalDispatched:writes.reduce((n,w)=>n+w.amount,0),expectedWrites:expected,storedComplete:stored.adjustmentsComplete,status:writes.length===expected?'PASS':'FAIL'});
 }
});
const value={level:'SERVICE local Convex and loopback HTTP; deliberately unexplained synthetic remaining balance, NOT a claim Stripe produces this invoice',results};
writeFileSync(new URL('./unexplained-remaining-complete-predecessor.json',import.meta.url),JSON.stringify(value,null,2)+'\n');console.log(JSON.stringify(value,null,2));if(results.some(r=>r.status==='FAIL'))process.exitCode=1;
