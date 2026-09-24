import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
import {ConvexHttpClient} from 'convex/browser';
import {api} from './convex/_generated/api.js';
import {withPayments} from './local.mjs';
import {trustedAdapter} from './adapter.mjs';
const results=[];
await withPayments(async({url,run})=>{
 const c=new ConvexHttpClient(url,{logger:false}),m=(n,a)=>c.mutation(api.payments[n],a);
 const cases=[
  {name:'Unexplained remaining50 refuses both37',remaining:50,amounts:[37,37],expected:[]},
  {name:'Unexplained due50 is observed but refuses both37',observe:true,due:50,remaining:50,amounts:[37,37],expected:[]},
  {name:'Consistent137 permits37+37+63',amounts:[37,37,63],expected:[37,37,63]},
  {name:'Consistent137 with37+37 held refuses64',amounts:[37,37,64],expected:[37,37]},
  {name:'Partial paid40 permits97 and refuses98',paid:40,amounts:[98,97],expected:[97]},
  {name:'Pre-credit30 on unpaid100 permits70 and refuses71',total:100,pre:30,amounts:[71,70],expected:[70]},
  {name:'Pre-credit30 and paid40 permit30 and refuse31',total:100,paid:40,pre:30,amounts:[31,30],expected:[30]},
  {name:'Post-credit30 after paid100 preserves observation and refuses collection',total:100,paid:100,post:30,amounts:[1],expected:[],status:'paid',observe:true},
  {name:'Refund30 after paid100 never reopens collection',total:100,paid:100,refund:30,amounts:[1],expected:[],status:'paid',observe:true},
  {name:'Negative starting balance refused',starting:-20,due:117,remaining:117,amounts:[37],expected:[]},
  {name:'Positive starting balance refused',starting:20,due:157,remaining:157,amounts:[37],expected:[]},
  {name:'Overpaid shape refused',overpaid:1,amounts:[37],expected:[]},
  ...[undefined,'137',136.5,-1].map((bad,i)=>({name:'Malformed remaining '+i,badField:'amount_remaining',bad,amounts:[37],expected:[]})),
  {name:'Missing starting balance refused',badField:'starting_balance',bad:undefined,amounts:[37],expected:[]},
  {name:'Missing overpaid refused',badField:'amount_overpaid',bad:undefined,amounts:[37],expected:[]},
  {name:'Explained first read but final changed credits refuses',drift:true,amounts:[37],expected:[]},
  {name:'Attachment refuses newly unexplained balance',attach:true,amounts:[37],expected:[37]},
 ];
 for(const spec of cases){
  const f=run('harness:seed',{run:randomUUID(),tokens:Array.from({length:10},()=>randomUUID())}),token=f.A.adapter,owner=f.A.sessions.owner;
  const customerId='cus_'+randomUUID().replaceAll('-',''),invoiceId='in_'+randomUUID().replaceAll('-',''),total=spec.total??137,paid=spec.paid??0,pre=spec.pre??0,post=spec.post??0;
  const customer=await m('registerCustomer',{token,binding:f.A.binding,externalId:customerId,name:'Remaining balance synthetic'}),document=await m('prepareInvoice',{token:owner,customer,amountMinor:total,currency:'usd',kind:'invoice'});await m('attachProvider',{token,id:document,externalId:invoiceId});
  const invoice={id:invoiceId,customer:customerId,currency:'usd',livemode:false,status:spec.status??'open',collection_method:'send_invoice',auto_advance:false,application_fee_amount:null,total,amount_due:spec.due??total-pre,amount_paid:paid,amount_remaining:spec.remaining??total-pre-paid,pre_payment_credit_notes_amount:pre,post_payment_credit_notes_amount:post,starting_balance:spec.starting??0,amount_overpaid:spec.overpaid??0};
  if(spec.badField)invoice[spec.badField]=spec.bad;
  const payment={id:'inpay_synthetic',invoice:invoiceId,currency:'usd',livemode:false,status:'paid',amount_paid:paid,payment:{type:'payment_intent',payment_intent:'pi_outside'}};
  const writes=[],attempts=[];let reads=0,attachmentPhase=false,lastPi;
  const server=createServer(async(req,res)=>{
   const path=new URL(req.url,'http://localhost').pathname;let body='';for await(const chunk of req)body+=chunk;const params=Object.fromEntries(new URLSearchParams(body));let out;
   if(req.method==='POST'){writes.push({path,amount:Number(params.amount)||0});lastPi={id:'pi_'+writes.length,livemode:false,status:'succeeded',customer:customerId,currency:'usd',amount:Number(params.amount),amount_received:Number(params.amount),metadata:{remold_command:params['metadata[remold_command]']}};out=lastPi;}
   else if(path.startsWith('/v1/accounts/'))out={charges_enabled:true,capabilities:{card_payments:'active'},requirements:{disabled_reason:null,currently_due:[]}};
   else if(path==='/v1/invoices/'+invoiceId){reads++;out={...invoice,...(attachmentPhase?{amount_remaining:50}:{}),...(spec.drift&&reads%2===0?{pre_payment_credit_notes_amount:1,amount_due:total-1,amount_remaining:total-1}: {})};}
   else if(path==='/v1/invoice_payments')out={data:paid?[payment]:[],has_more:false};
   else if(path==='/v1/invoice_payments/inpay_synthetic')out=payment;
   else if(path==='/v1/payment_intents/pi_outside')out={id:'pi_outside',livemode:false,currency:'usd',status:'succeeded',amount_received:paid,latest_charge:'ch_outside'};
   else if(path.startsWith('/v1/payment_intents/'))out=lastPi;
   else if(path==='/v1/charges/ch_outside')out={id:'ch_outside',payment_intent:'pi_outside',currency:'usd',livemode:false,amount:paid,amount_refunded:spec.refund??0};
   else if(path==='/v1/refunds')out={data:spec.refund?[{id:'re_outside'}]:[],has_more:false};
   else if(path==='/v1/refunds/re_outside')out={id:'re_outside',charge:'ch_outside',payment_intent:'pi_outside',amount:spec.refund,currency:'usd',status:'succeeded'};
   else if(path==='/v1/credit_notes')out={data:pre+post?[{id:'cn_outside'}]:[],has_more:false};
   else if(path==='/v1/credit_notes/cn_outside')out={id:'cn_outside',invoice:invoiceId,amount:pre+post,currency:'usd',livemode:false,status:'issued'};
   else{res.writeHead(404).end('{}');return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(out));
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const stripe={request:async(method,path,params={},account)=>{if(account)assert.equal(account,f.A.key.account);const u=new URL(path,'http://127.0.0.1:'+server.address().port);if(method==='GET')u.search=new URLSearchParams(params);const response=await fetch(u,{method,...(method==='POST'?{body:new URLSearchParams(params)}:{})});assert.equal(response.status,200);return response.json();}};
  let error;
  try{
   const adapter=trustedAdapter(stripe,c,f);
   if(spec.observe){await adapter.observe('A',invoiceId,randomUUID(),randomUUID());const d=await c.query(api.payments.getDocument,{token:owner,id:document});assert.equal(d.paidMinor,paid);assert.equal(d.creditedMinor,pre+post);assert.equal(d.refundedMinor,spec.refund??0);assert.equal(d.adjustmentsComplete,true);}
   for(const amount of spec.amounts){try{await adapter.execute('A',document,{customer:customerId,amount,currency:'usd',payment_method:'pm_synthetic','payment_method_types[]':'card',confirm:true},'POST','/v1/payment_intents',{stage:randomUUID()});attempts.push({amount,accepted:true});}catch(e){attempts.push({amount,accepted:false,reason:e.message});}}
   if(spec.attach){attachmentPhase=true;await assert.rejects(adapter.execute('A',document,{payment_intent:lastPi.id},'POST','/v1/invoices/'+invoiceId+'/attach_payment'));assert.equal(writes.filter(w=>w.path.endsWith('/attach_payment')).length,0);}
   assert.deepEqual(writes.filter(w=>w.path==='/v1/payment_intents').map(w=>w.amount),spec.expected);
  }catch(e){error=e.message;}finally{await new Promise(r=>server.close(r));}
  const row={name:spec.name,status:error?'FAIL':'PASS',attempts,writes,...(error?{error}:{})};results.push(row);console.log(row.status+' '+spec.name);
 }
});
writeFileSync(new URL('./evidence/remaining.json',import.meta.url),JSON.stringify({level:'SERVICE local Convex and loopback HTTP; synthetic provider states, no Stripe calls',results},null,2)+'\n');assert.equal(results.filter(r=>r.status==='FAIL').length,0);
