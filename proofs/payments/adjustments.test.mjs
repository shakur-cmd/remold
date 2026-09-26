import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {pullAdjustments} from './adjustments.mjs';

const invoice={id:'in_synthetic',livemode:false,currency:'usd',amount_paid:100,total:100,status:'paid',pre_payment_credit_notes_amount:30,post_payment_credit_notes_amount:0};
async function fixture(mode,check){
 const requests=[];
 const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');requests.push(url.pathname+url.search);
  assert.equal(req.method,'GET');assert.equal(req.headers['stripe-account'],'acct_synthetic_a');
  const list=(data,has_more=false)=>({data,has_more}),cursor=url.searchParams.get('starting_after');let value;
  const refund=(id,amount)=>({id,amount,charge:'ch_synthetic',payment_intent:'pi_synthetic',currency:'usd',status:'succeeded'});
  const note=(id,amount)=>({id,amount,invoice:invoice.id,currency:'usd',livemode:false,status:'issued'});
  switch(url.pathname){
   case '/v1/invoice_payments':value=list([{id:'inpay_synthetic',invoice:invoice.id,currency:'usd',livemode:false,status:'paid',amount_paid:100,payment:{type:'payment_intent',payment_intent:'pi_synthetic'}}]);break;
   case '/v1/invoice_payments/inpay_synthetic':value={id:'inpay_synthetic',invoice:invoice.id,currency:'usd',livemode:false,status:mode==='open-payment'?'open':mode==='canceled-inflight'?'canceled':'paid',amount_paid:100,payment:{type:'payment_intent',payment_intent:'pi_synthetic'}};break;
   case '/v1/payment_intents/pi_synthetic':value={id:'pi_synthetic',livemode:false,currency:'usd',status:['open-payment','canceled-inflight'].includes(mode)?'processing':'succeeded',amount_received:mode==='partial-payment'?99:100,latest_charge:'ch_synthetic'};break;
   case '/v1/charges/ch_synthetic':value={id:'ch_synthetic',payment_intent:'pi_synthetic',livemode:false,currency:'usd',amount:100,amount_refunded:mode==='pending'?20:30};break;
   case '/v1/refunds':
    if(mode==='failure'&&cursor){res.writeHead(503);res.end('{}');return;}
    if(mode==='bound'){value=list([refund('re_'+requests.length,1)],true);break;}
    if(mode==='empty'){value=list([],true);break;}
    value=cursor?list([refund(mode==='repeat'?'re_1':'re_2',20)]):list([refund('re_1',10)],true);
    
    if(mode==='foreign')value.data[0].charge='ch_foreign';
    break;
   case '/v1/credit_notes':value=cursor?list([note('cn_2',20)]):list([note('cn_1',10)],true);break;
   case '/v1/invoices/in_synthetic':value={...invoice,pre_payment_credit_notes_amount:mode==='mismatch'?31:30};break;
   default:
    if(url.pathname.startsWith('/v1/refunds/')){const id=url.pathname.split('/').at(-1);value=refund(id,id==='re_1'?10:20);if(mode==='pending'&&id==='re_1')value.status='pending';if(mode==='unknown')value.status='unsupported';if(mode==='foreign')value.charge='ch_foreign';break;}
    if(url.pathname.startsWith('/v1/credit_notes/')){const id=url.pathname.split('/').at(-1);value=note(id,id==='cn_1'?10:20);value.refunds=[{refund:mode==='link'?'re_missing':id==='cn_1'?'re_1':'re_2',amount_refunded:value.amount}];break;}
    res.writeHead(404);res.end('{}');return;
  }
  res.setHeader('content-type','application/json');res.end(JSON.stringify(value));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const stripe={request:async(method,path,params,account)=>{const url=new URL(path,'http://127.0.0.1:'+server.address().port);url.search=new URLSearchParams(params).toString();const response=await fetch(url,{method,headers:{'Stripe-Account':account}});if(!response.ok)throw Error('Provider read failed');return response.json();}};
 try{await check(stripe,requests);}finally{await new Promise(resolve=>server.close(resolve));}
}
test('Complete cursor traversal normalizes every distinct refund and credit receipt',()=>fixture('complete',async(stripe,requests)=>{
 const result=await pullAdjustments(stripe,invoice,'acct_synthetic_a');
 assert.equal(result.refundedMinor,30);assert.equal(result.creditedMinor,30);assert.deepEqual(result.receipts.map(r=>r.receiptId),['inpay_synthetic','re_1','re_2','cn_1','cn_2']);
 assert.ok(requests.some(r=>r.includes('starting_after=re_1')));assert.ok(requests.some(r=>r.includes('starting_after=cn_1')));
}));
for(const [mode,reason]of [['canceled-inflight',/Unresolved provider payment/],['open-payment',/Unresolved provider payment/],['partial-payment',/Partial payment allocation/],['failure',/Provider read failed/],['bound',/page bound/],['empty',/Empty incomplete/],['repeat',/Repeated provider/],['unknown',/Unknown provider refund status/],['link',/Credit-note refund link/],['foreign',/ch_foreign/],['mismatch',/Invoice balance changed during traversal/]]){
 test('No complete result after '+mode,()=>fixture(mode,(stripe)=>assert.rejects(pullAdjustments(stripe,invoice,'acct_synthetic_a'),reason)));
}

test('Outside pending refund is normalized as held, not silently omitted',()=>fixture('pending',async(stripe)=>{const value=await pullAdjustments(stripe,invoice,'acct_synthetic_a');assert.equal(value.refundedMinor,20);assert.equal(value.receipts.find(r=>r.receiptId==='re_1').status,'pending');assert.equal(value.receipts.find(r=>r.receiptId==='re_1').amountMinor,10);}));
