import assert from'node:assert/strict';import{randomUUID}from'node:crypto';import{createServer}from'node:http';import{writeFileSync}from'node:fs';import{ConvexHttpClient}from'convex/browser';import{api}from'./convex/_generated/api.js';import{withPayments}from'./local.mjs';import{trustedAdapter}from'./adapter.mjs';
const results=[];
await withPayments(async({url,run})=>{
 const c=new ConvexHttpClient(url,{logger:false}),m=(n,a)=>c.mutation(api.payments[n],a);
 const cases=[
  ['invoice-pay','pay',{},{}],['subscription-create','subscription',{},{}],
  ...[{auto_advance:true},{collection_method:'charge_automatically'},{pending_invoice_items_behavior:'include'},{'from_invoice[invoice]':'in_foreign'},{default_payment_method:'pm_synthetic'},{'automatic_tax[enabled]':true},{'discounts[0][coupon]':'coupon_synthetic'}].map((params,i)=>['unsafe-invoice-'+i,'create',params,{}]),
  ['under-item','item',{amount:99},{}],['price-item','item',{price:'price_synthetic',quantity:1},{}],['unbound-item','item',{invoice:undefined},{}],['second-item','item',{}, {lines:1}],
  ['auto-finalize','finalize',{auto_advance:true},{}],['wrong-total-finalize','finalize',{}, {total:99}],
  ['unreserved-attachment','attach',{},{}],['inactive-card','pi',{}, {card:'pending'}],['requirements-due','pi',{}, {due:['individual.id_number']}],
  ['automatic-collection','pi',{}, {collection:'charge_automatically'}],['subscription-invoice','pi',{}, {subscription:true}],
  ['shape-drift','pi',{}, {drift:'second'}],['last-read-shape-drift','pi',{}, {drift:'last'}],['remaining-drift','pi',{}, {drift:'remaining'}],
  ['platform-fee','pi',{application_fee_amount:1},{}],['off-session','pi',{off_session:true},{}],['transfer','pi',{'transfer_data[destination]':'acct_foreign'},{}]
 ];
 for(const[name,route,overrides,state]of cases){
  const f=run('harness:seed',{run:randomUUID(),tokens:Array.from({length:10},()=>randomUUID())}),owner=f.A.sessions.owner,token=f.A.adapter;const externalCustomer='cus_synthetic';const customer=await m('registerCustomer',{token,binding:f.A.binding,externalId:externalCustomer,name:'Route-policy synthetic'}),doc=await m('prepareInvoice',{token:owner,customer,amountMinor:100,currency:'usd',kind:'invoice'}),invoice='in_synthetic';
  if(!['create','subscription'].includes(route)){await m('attachProvider',{token,id:doc,externalId:invoice});const args={token,binding:f.A.binding,externalId:invoice,receipts:[],refundedMinor:0,creditedMinor:0};const epoch=await m('reconcileAdjustments',{...args,complete:false});await m('reconcileAdjustments',{...args,complete:true,epoch});}
  let invoiceReads=0,receiptTraversalFinished=false;const requests=[];const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({method:req.method,path:req.url});const path=new URL(req.url,'http://localhost').pathname;let response;
   if(path.startsWith('/v1/accounts/'))response={charges_enabled:true,capabilities:{card_payments:state.card??'active'},requirements:{currently_due:state.due??[],disabled_reason:null}};
   else if(path.startsWith('/v1/prices/'))response={unit_amount:100,currency:'usd',recurring:{interval:'month'}};
   else if(path==='/v1/invoice_payments'||path==='/v1/credit_notes'){if(path==='/v1/credit_notes')receiptTraversalFinished=true;response={data:[],has_more:false};}
   else if(req.method==='GET'){invoiceReads++;response={id:invoice,customer:externalCustomer,currency:'usd',livemode:false,status:route==='pi'?'open':'draft',amount_paid:0,amount_remaining:state.drift==='remaining'&&invoiceReads>=2?99:100,pre_payment_credit_notes_amount:0,post_payment_credit_notes_amount:0,starting_balance:0,amount_overpaid:0,collection_method:state.drift==='second'&&invoiceReads>=2?'charge_automatically':state.collection??'send_invoice',auto_advance:false,total:state.total??100,amount_due:state.total??100,application_fee_amount:null,subscription:state.subscription||(state.drift==='last'&&receiptTraversalFinished)?'sub_synthetic':null,lines:{data:Array.from({length:state.lines??(route==='item'?0:1)},()=>({amount:100})),has_more:false}};}
   else response={id:route==='pi'?'pi_synthetic':invoice,livemode:false};res.setHeader('Content-Type','application/json');res.end(JSON.stringify(response));
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));const stripe={request:async(method,path,params={})=>(await fetch('http://127.0.0.1:'+server.address().port+path,{method,...(method==='POST'?{body:new URLSearchParams(params)}:{})})).json()};
  const defs={create:['/v1/invoices',{customer:externalCustomer,collection_method:'send_invoice',days_until_due:30,auto_advance:false,pending_invoice_items_behavior:'exclude'}],item:['/v1/invoiceitems',{customer:externalCustomer,invoice,amount:100,currency:'usd',description:'Synthetic'}],finalize:['/v1/invoices/'+invoice+'/finalize',{auto_advance:false}],attach:['/v1/invoices/'+invoice+'/attach_payment',{payment_intent:'pi_unreserved'}],pay:['/v1/invoices/'+invoice+'/pay',{payment_method:'pm_synthetic'}],subscription:['/v1/subscriptions',{customer:externalCustomer,'items[0][price]':'price_synthetic'}],pi:['/v1/payment_intents',{customer:externalCustomer,amount:100,currency:'usd',payment_method:'pm_synthetic','payment_method_types[]':'card',confirm:true}]};
  const[path,base]=defs[route],params={...base,...overrides};for(const key of Object.keys(params))if(params[key]===undefined)delete params[key];let refused=false,error;
  try{await trustedAdapter(stripe,c,f).execute('A',doc,params,'POST',path);}catch(e){refused=true;error=e.message;}finally{await new Promise(r=>server.close(r));}
  const writes=requests.filter(r=>r.method==='POST').length;results.push({name,refused,writes,status:refused&&writes===0?'PASS':'FAIL',...(refused?{reason:error}:{})});console.log(results.at(-1).status+' '+name);
 }
});
writeFileSync(new URL('./evidence/route-policy.json',import.meta.url),JSON.stringify({level:'SERVICE loopback HTTP and local Convex; provider responses simulated',results},null,2)+'\n');assert.equal(results.filter(r=>r.status==='FAIL').length,0);
