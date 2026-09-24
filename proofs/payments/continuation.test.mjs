import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claimContinuation,checkCustomers,setCustomerEmails,CUSTOMERS,FIRST_RUN,CONTINUATION_ID} from './continuation.mjs';
async function fixture(mode,check){
 const directory=mkdtempSync(join(tmpdir(),'remold-continuation-')),evidenceDirectory=join(directory,'evidence'),privateDirectory=join(directory,'private');mkdirSync(evidenceDirectory);copyFileSync(new URL('./evidence/sandbox-first-enabled-attempt.json',import.meta.url),join(evidenceDirectory,'sandbox-first-enabled-attempt.json'));
 const options={privateDirectory,evidenceDirectory,sourceAggregate:'synthetic-source'},journal=claimContinuation(options),rows=Object.fromEntries(Object.entries(CUSTOMERS).map(([name,v])=>[v.customer,{id:v.customer,name:'Synthetic P4 customer '+name,livemode:false,email:null,balance:0,metadata:{remold_fixture:FIRST_RUN}}]));
 const requests=[],receipts=[];let changed=false;
 const server=createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost'),path=u.pathname;let body='';for await(const chunk of req)body+=chunk;const params=Object.fromEntries(new URLSearchParams(body));const customer=path.split('/')[3]??u.searchParams.get('customer');
  const known=Object.values(CUSTOMERS).find(v=>v.customer===customer);if(known)assert.equal(req.headers['stripe-account'],known.account);
  requests.push({method:req.method,path,params});let value;
  if(req.method==='POST'){
   assert.ok(readFileSync(journal.path,'utf8').includes('write-attempt'),'Attempt persisted before dispatch');assert.deepEqual(Object.keys(params),['email']);assert.match(params.email,/@remold\.invalid$/);assert.equal(req.headers['idempotency-key'],CONTINUATION_ID+'-email-'+(customer===CUSTOMERS.A.customer?'A':'B'));
   rows[customer].email=params.email;changed=true;
   if(mode==='lost'){req.socket.destroy();return;}value=rows[customer];
  }else if(path.endsWith('/cash_balance'))value={customer,livemode:false,available:null};
  else if(path.startsWith('/v1/customers/')&&!path.endsWith('/balance_transactions'))value={...rows[customer],...(mode==='wrong-scope'?{id:'cus_foreign'}:{}),...(mode==='readback'&&changed?{metadata:{remold_fixture:'wrong'}}:{})};
  else value={data:mode==='nonempty'&&path==='/v1/invoiceitems'?[{id:'ii_existing'}]:[],has_more:mode==='incomplete'&&path==='/v1/invoices'};
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const raw={receipts,request:async(method,path,params={},account,key)=>{const url=new URL(path,'http://127.0.0.1:'+server.address().port);if(method==='GET')url.search=new URLSearchParams(params);const response=await fetch(url,{method,headers:{'Stripe-Account':account,...(key?{'Idempotency-Key':key}:{})},...(method==='POST'?{body:new URLSearchParams(params)}:{})});const result=await response.json();receipts.push({method,path,account,httpStatus:response.status,requestId:'req_synthetic_'+receipts.length});return result;}};
 try{await check({stripe:journal.wrap(raw),journal,requests,options,rows});}finally{await new Promise(resolve=>server.close(resolve));rmSync(directory,{recursive:true,force:true});}
}
test('Continuation reuses both exact customers with email-only updates and durable receipts',()=>fixture('clean',async({stripe,journal,requests})=>{
 const snapshot=await checkCustomers(stripe,journal);assert.equal(requests.filter(r=>r.method==='POST').length,0);await setCustomerEmails(stripe,journal,snapshot);
 const posts=requests.filter(r=>r.method==='POST');assert.deepEqual(posts.map(r=>r.path),Object.values(CUSTOMERS).map(v=>'/v1/customers/'+v.customer));assert.equal(posts.some(r=>r.path==='/v1/customers'),false);
 const log=readFileSync(journal.path,'utf8').trim().split('\n').map(JSON.parse);assert.equal(log.filter(r=>r.kind==='write-response').length,2);assert.equal(log.filter(r=>r.kind==='email-readback').length,2);assert.equal(statSync(journal.path).mode&0o077,0);
}));
for(const mode of ['wrong-scope','nonempty','incomplete'])test('Continuation refuses '+mode+' before any provider write',()=>fixture(mode,async({stripe,journal,requests})=>{await assert.rejects(checkCustomers(stripe,journal));assert.equal(requests.filter(r=>r.method==='POST').length,0);}));
test('An existing one-shot latch refuses a second start before a provider call',()=>fixture('clean',async({options,requests})=>{const before=requests.length;assert.throws(()=>claimContinuation(options),/EEXIST/);assert.equal(requests.length,before);}));
test('Lost response retains the attempted update and refuses restart',()=>fixture('lost',async({stripe,journal,requests,options,rows})=>{
 const snapshot=await checkCustomers(stripe,journal);await assert.rejects(setCustomerEmails(stripe,journal,snapshot));assert.match(rows[CUSTOMERS.A.customer].email,/@remold\.invalid$/);assert.equal(requests.filter(r=>r.method==='POST').length,1);
 const last=JSON.parse(readFileSync(journal.path,'utf8').trim().split('\n').at(-1));assert.equal(last.kind,'write-error');assert.equal(last.outcome,'unknown');assert.throws(()=>claimContinuation(options),/EEXIST/);
}));
test('A changed email readback stops before updating the second customer',()=>fixture('readback',async({stripe,journal,requests})=>{const snapshot=await checkCustomers(stripe,journal);await assert.rejects(setCustomerEmails(stripe,journal,snapshot));assert.equal(requests.filter(r=>r.method==='POST').length,1);}));
