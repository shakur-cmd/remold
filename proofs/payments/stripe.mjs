import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const API_VERSION='2025-05-28.basil';
export const SANDBOX_ACCOUNT='acct_1UJHeKJjT84hNemU';
export function credentials(){
 const path=new URL('../../.env.remold-sandbox.local',import.meta.url);
 assert.equal(statSync(path).mode&0o077,0,'Sandbox credential file must be private');
 const values={};
 for(const line of readFileSync(path,'utf8').split('\n')){
  const match=/^(STRIPE_SECRET_KEY|STRIPE_SANDBOX_ACCOUNT)=(.*)$/.exec(line);
  if(match)values[match[1]]=match[2].trim().replace(/^['"]|['"]$/g,'');
 }
 if(!/^sk_test_[A-Za-z0-9]+$/.test(values.STRIPE_SECRET_KEY??''))throw new Error('Test secret key required');
 assert.equal(values.STRIPE_SANDBOX_ACCOUNT,SANDBOX_ACCOUNT,'Unexpected sandbox');
 return values.STRIPE_SECRET_KEY;
}
export class OutcomeUnknown extends Error { constructor(){super('Injected response loss after actual sandbox provider commit');} }
export class StripeFailure extends Error{
 constructor(status,error,requestId){super(`Stripe sandbox request failed: ${status} ${error.type??'unknown'} ${error.code??'no-code'} ${error.param??'no-param'}`);this.status=status;this.code=error.code;this.param=error.param;this.requestId=requestId;this.providerMessage=error.message;}
}
export function provider(secret){
 if(typeof secret!=='string'||!/^sk_test_[A-Za-z0-9]+$/.test(secret))throw new Error('Test secret key required');
 const receipts=[];
 async function request(method,path,params={},account,idempotency,{loseResponse=false}={}){
  if(loseResponse)assert.equal(method,'POST','Only committed POST response loss is supported');
  assert.match(path,/^\/v1\/[a-z0-9_/-]+$/i);
  if(account)assert.match(account,/^acct_[a-zA-Z0-9]+$/);
  const form=new URLSearchParams();for(const [key,value]of Object.entries(params))if(value!==undefined)form.append(key,String(value));
  const url='https://api.stripe.com'+path+(method==='GET'&&form.size?'?'+form:'');
  const response=await fetch(url,{method,headers:{Authorization:`Bearer ${secret}`,'Stripe-Version':API_VERSION,...(account?{'Stripe-Account':account}:{}),...(idempotency?{'Idempotency-Key':idempotency}:{}),...(method!=='GET'?{'Content-Type':'application/x-www-form-urlencoded'}:{})},...(method!=='GET'?{body:form}:{}),signal:AbortSignal.timeout(30_000)});
  const body=await response.json();
  receipts.push({method,path,responseLossInjected:loseResponse,account:account??SANDBOX_ACCOUNT,idempotencyDigest:idempotency?createHash('sha256').update(idempotency).digest('hex'):null,httpStatus:response.status,requestId:response.headers.get('request-id'),apiVersion:response.headers.get('stripe-version')??API_VERSION});
  assert.notEqual(body.livemode,true,'Live response refused');
  if(!response.ok)throw new StripeFailure(response.status,body.error??{},response.headers.get('request-id'));
  if(loseResponse)throw new OutcomeUnknown();
  return body;
 }
 async function verify(){const account=await request('GET','/v1/account');assert.equal(account.id,SANDBOX_ACCOUNT);const balance=await request('GET','/v1/balance');assert.equal(balance.livemode,false);return {account:account.id,livemode:balance.livemode};}
 return {request,verify,receipts};
}
