import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync} from 'node:fs';
import {ConvexHttpClient} from 'convex/browser';
import {api} from '../../../../proofs/payments/convex/_generated/api.js';
import {withPayments} from '../../../../proofs/payments/local.mjs';
import {trustedAdapter} from '../../../../proofs/payments/adapter.mjs';
const results=[],source={};
for(const path of ['adapter.mjs','adjustments.mjs','convex/payments.ts'])source[path]=createHash('sha256').update(readFileSync(new URL('../../../../proofs/payments/'+path,import.meta.url))).digest('hex');
await withPayments(async({url,run})=>{
 const c=new ConvexHttpClient(url,{logger:false}),m=(n,a)=>c.mutation(api.payments[n],a);
 for(const scenario of ['second-auto','final-subscription','final-remaining','final-paid','stable']){
  const f=run('harness:seed',{run:randomUUID(),tokens:Array.from({length:10},()=>randomUUID())}),token=f.A.adapter,owner=f.A.sessions.owner;
  const externalCustomer='cus_iv_'+randomUUID().replaceAll('-',''),externalId='in_iv_'+randomUUID().replaceAll('-','');
  const customer=await m('registerCustomer',{token,binding:f.A.binding,externalId:externalCustomer,name:'IV snapshot drift'});
  const doc=await m('prepareInvoice',{token:owner,customer,amountMinor:137,currency:'usd',kind:'invoice'});await m('attachProvider',{token,id:doc,externalId});
  const snapshots=[],writes=[];let reads=0;
  const server=createServer(async(req,res)=>{
   const path=new URL(req.url,'http://localhost').pathname;let body='';for await(const chunk of req)body+=chunk;let value;
   if(req.method==='POST'){writes.push({path,amount:Number(new URLSearchParams(body).get('amount'))});value={id:'pi_iv_'+randomUUID().replaceAll('-',''),livemode:false};}
   else if(path.startsWith('/v1/accounts/'))value={charges_enabled:true,capabilities:{card_payments:'active'},requirements:{disabled_reason:null,currently_due:[]}};
   else if(path==='/v1/invoice_payments'||path==='/v1/credit_notes')value={data:[],has_more:false};
   else if(path==='/v1/invoices/'+externalId){
    reads++;value={id:externalId,customer:externalCustomer,currency:'usd',livemode:false,status:'open',collection_method:'send_invoice',auto_advance:false,subscription:null,application_fee_amount:null,total:137,amount_due:137,amount_paid:0,amount_remaining:137,pre_payment_credit_notes_amount:0,post_payment_credit_notes_amount:0,lines:{data:[{amount:137}],has_more:false}};
    if(scenario==='second-auto'&&reads>=2)value.collection_method='charge_automatically';
    if(scenario==='final-subscription'&&reads>=3)value.parent={type:'subscription_details',subscription_details:{subscription:'sub_iv'}};
    if(scenario==='final-remaining'&&reads>=3){value.amount_due=26;value.amount_remaining=26;}
    if(scenario==='final-paid'&&reads>=3){value.amount_paid=109;value.amount_remaining=28;}
    snapshots.push({read:reads,collection:value.collection_method,parentType:value.parent?.type??null,paid:value.amount_paid,due:value.amount_due,remaining:value.amount_remaining});
   }else{res.writeHead(404).end('{}');return;}
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const stripe={request:async(method,path,params={},account)=>{if(account)assert.equal(account,f.A.key.account);const u=new URL(path,'http://127.0.0.1:'+server.address().port);if(method==='GET')u.search=new URLSearchParams(params);const response=await fetch(u,{method,...(method==='POST'?{body:new URLSearchParams(params)}:{})});assert.equal(response.status,200);return response.json();}};
  let refused=false,error=null;
  try{await trustedAdapter(stripe,c,f).execute('A',doc,{customer:externalCustomer,amount:37,currency:'usd',payment_method:'pm_iv','payment_method_types[]':'card',confirm:true},'POST','/v1/payment_intents');}catch(e){refused=true;error=e.message;}finally{await new Promise(r=>server.close(r));}
  const stored=await c.query(api.payments.getDocument,{token:owner,id:doc}),expectedWrites=scenario==='stable'?1:0;
  const status=writes.length===expectedWrites&&refused===(scenario!=='stable')?'PASS':'FAIL';
  results.push({scenario,expectedWrites,writes,refused,error,snapshots,stored:{state:stored.state,paid:stored.paidMinor,complete:stored.adjustmentsComplete},status});
 }
});
const value={level:'SERVICE local Convex and loopback HTTP; synthetic invoice snapshots, no Stripe calls',source,results};
writeFileSync(new URL('./observed-shape.json',import.meta.url),JSON.stringify(value,null,2)+'\n');console.log(JSON.stringify(value,null,2));
if(results.some(r=>r.status==='FAIL'))process.exitCode=1;
