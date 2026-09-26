import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {invoiceOrigin,proveNoPlatformFee,SANDBOX_APPLICATION} from './invoice-contract.mjs';
const base={issuer:{type:'self'},application:SANDBOX_APPLICATION};
test('Absent Basil invoice fee stays unobserved; explicit null stays explicit',()=>{assert.equal(invoiceOrigin(base).invoiceFeeField,'absent-unobserved');assert.equal(invoiceOrigin({...base,application_fee_amount:null}).invoiceFeeField,'explicit-null');});
for(const value of [0,1,'0',{},undefined])test('Explicit invoice fee '+String(value)+' is refused',()=>assert.throws(()=>invoiceOrigin({...base,application_fee_amount:value})));
for(const extra of [{issuer:undefined},{issuer:{type:'account',account:'acct_other'}},{application:undefined},{application:'ca_other'},{transfer_data:{destination:'acct_other'}},{on_behalf_of:'acct_other'}])test('Unsupported invoice provenance '+JSON.stringify(extra)+' is refused',()=>assert.throws(()=>invoiceOrigin({...base,...extra})));
async function fixture(mode,check){
 const requests=[],pi={id:'pi_synthetic',livemode:false,status:'succeeded',customer:'cus_synthetic',amount:301,amount_received:301,currency:'usd',latest_charge:'ch_synthetic',application_fee_amount:null,transfer_data:null,on_behalf_of:null},charge={id:'ch_synthetic',livemode:false,payment_intent:pi.id,customer:pi.customer,amount:301,currency:'usd',paid:true,application_fee:null,application_fee_amount:null,transfer_data:null,on_behalf_of:null};
 if(mode==='missing-pi')delete pi.application_fee_amount;if(mode==='pi-fee')pi.application_fee_amount=1;if(mode==='missing-charge')delete charge.application_fee;if(mode==='charge-fee')charge.application_fee_amount=1;if(mode==='foreign-charge')charge.payment_intent='pi_other';
 const server=createServer((req,res)=>{const u=new URL(req.url,'http://localhost');assert.equal(req.method,'GET');requests.push(u.pathname);const platform=u.pathname==='/v1/application_fees';assert.equal(req.headers['stripe-account'],platform?undefined:'acct_synthetic');if(platform)assert.equal(u.searchParams.get('charge'),charge.id);const value=platform?{data:mode==='platform-fee'?[{id:'fee_synthetic'}]:[],has_more:mode==='incomplete'}:u.pathname.includes('/charges/')?charge:pi;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const stripe={request:async(method,path,params={},account)=>{const u=new URL(path,'http://127.0.0.1:'+server.address().port);u.search=new URLSearchParams(params);return(await fetch(u,{method,headers:account?{'Stripe-Account':account}:{}})).json();}};
 try{await check(()=>proveNoPlatformFee(stripe,{paymentIntent:pi.id,account:'acct_synthetic',customer:pi.customer,amountMinor:301}),requests);}finally{await new Promise(r=>server.close(r));}
}
test('No-fee proof requires exact scoped PI and charge plus complete platform empty fee list',()=>fixture('clean',async(run,requests)=>{assert.equal((await run()).status,'PASS');assert.deepEqual(requests,['/v1/payment_intents/pi_synthetic','/v1/charges/ch_synthetic','/v1/application_fees']);}));
for(const mode of ['missing-pi','missing-charge'])test(mode+' is UNOBSERVED, never zero',()=>fixture(mode,run=>assert.rejects(run(),e=>e.evidenceStatus==='UNOBSERVED')));
for(const mode of ['pi-fee','charge-fee','foreign-charge','platform-fee','incomplete'])test(mode+' cannot pass no-fee proof',()=>fixture(mode,run=>assert.rejects(run())));
