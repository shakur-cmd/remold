import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,mkdirSync,openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {join} from 'node:path';
export const FIRST_RUN='3f7c6229-f345-4b59-8b6a-971208c4efe7';
export const CONTINUATION_ID=FIRST_RUN+'-manual-continuation-1';
export const FIRST_ATTEMPT_SHA='4d95a7a51b1517fd11f123aefbae5715812cf0860e6651bd4765569df95b4d6a';
export const CUSTOMERS={A:{account:'acct_1UJIndJL8hhTtG1o',customer:'cus_VJzrZTORGay5Lp'},B:{account:'acct_1UJL2DR59Pk6MTFE',customer:'cus_VJzr8q1ZtrR81v'}};
const digest=value=>createHash('sha256').update(value).digest('hex');
const email=name=>'p4-'+FIRST_RUN+'-'+name.toLowerCase()+'@remold.invalid';
function durable(path,row,flag){const fd=openSync(path,flag,0o600);try{writeSync(fd,JSON.stringify(row)+'\n');fsyncSync(fd);}finally{closeSync(fd);}}
export function claimContinuation({privateDirectory,evidenceDirectory,sourceAggregate}){
 const old=readFileSync(join(evidenceDirectory,'sandbox-first-enabled-attempt.json'));assert.equal(digest(old),FIRST_ATTEMPT_SHA,'Original attempt digest mismatch');
 const first=JSON.parse(old);assert.equal(first.runId,FIRST_RUN);assert.equal(first.results.length,0);assert.equal(first.objects.length,2);
 for(const {account,customer}of Object.values(CUSTOMERS))assert.ok(first.objects.some(o=>o.kind==='customer'&&o.account===account&&o.id===customer));
 mkdirSync(privateDirectory,{recursive:true,mode:0o700});const path=join(privateDirectory,CONTINUATION_ID+'.jsonl');
 durable(path,{kind:'started',id:CONTINUATION_ID,continuationOf:FIRST_RUN,sourceAggregate,firstAttemptSha:FIRST_ATTEMPT_SHA,customers:CUSTOMERS,emails:{A:email('A'),B:email('B')},at:new Date().toISOString()},'wx');
 const dir=openSync(privateDirectory,'r');try{fsyncSync(dir);}finally{closeSync(dir);}
 let sequence=0;
 const append=row=>durable(path,{...row,at:new Date().toISOString()},'a');
 return{path,append,wrap(stripe){return{...stripe,request:async(method,route,params={},account,key,options)=>{
  if(method==='GET')return stripe.request(method,route,params,account,key,options);
  const n=++sequence;assert.ok(key,'Continuation write requires idempotency key');
  append({kind:'write-attempt',sequence:n,method,path:route,account,idempotencyKey:key,idempotencyDigest:digest(key),payloadDigest:digest(JSON.stringify(params))});
  const index=stripe.receipts.length;
  try{const result=await stripe.request(method,route,params,account,key,options);append({kind:'write-response',sequence:n,objectId:result.id??null,receipt:stripe.receipts.at(-1)??null});return result;}
  catch(error){append({kind:'write-error',sequence:n,httpStatus:error.status??null,receipt:stripe.receipts.length>index?stripe.receipts.at(-1):null,outcome:error.status?'http-error':'unknown'});throw error;}
 }}}};
}
export async function checkCustomers(stripe,journal){
 const snapshot=[];
 for(const [name,{account,customer}]of Object.entries(CUSTOMERS)){
  const c=await stripe.request('GET','/v1/customers/'+customer,{},account);
  assert.equal(c.id,customer);assert.equal(c.livemode,false);assert.ok(!c.deleted);assert.equal(c.metadata?.remold_fixture,FIRST_RUN);assert.equal(c.name,'Synthetic P4 customer '+name);assert.ok(c.email==null||c.email==='');assert.equal(c.balance,0);
  const cash=await stripe.request('GET','/v1/customers/'+customer+'/cash_balance',{},account);assert.equal(cash.customer,customer);assert.equal(cash.livemode,false);assert.ok(cash.available==null||Object.keys(cash.available).length===0,'Existing cash balance unsupported');
  for(const path of ['/v1/invoices','/v1/invoiceitems','/v1/payment_intents','/v1/charges','/v1/subscriptions','/v1/setup_intents','/v1/customers/'+customer+'/balance_transactions']){
   const params={limit:100,...(!path.includes('/customers/')?{customer}:{}),...(path==='/v1/subscriptions'?{status:'all'}:{})};
   const list=await stripe.request('GET',path,params,account);assert.equal(list.has_more,false,'Incomplete prior inventory');assert.deepEqual(list.data,[],'Prior customer effects require review');
  }
  snapshot.push({name,account,customer,originalMetadata:c.metadata,originalName:c.name,balance:c.balance});
 }
 journal.append({kind:'preconditions',snapshot,receipts:stripe.receipts});return snapshot;
}
export async function setCustomerEmails(stripe,journal,snapshot){
 for(const row of snapshot){const {name,account,customer}=row;
  const updated=await stripe.request('POST','/v1/customers/'+customer,{email:email(name)},account,CONTINUATION_ID+'-email-'+name);assert.equal(updated.id,customer);assert.equal(updated.livemode,false);
  const c=await stripe.request('GET','/v1/customers/'+customer,{},account);assert.equal(c.id,customer);assert.equal(c.email,email(name));assert.equal(c.livemode,false);assert.equal(c.name,row.originalName);assert.equal(c.balance,0);assert.deepEqual(c.metadata,row.originalMetadata);
  journal.append({kind:'email-readback',account,customer,email:c.email,matched:true});
 }
}
