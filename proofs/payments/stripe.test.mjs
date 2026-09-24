import{test}from'node:test';
import assert from'node:assert/strict';
import{provider}from'./stripe.mjs';
test('provider refuses live or malformed credentials without revealing them',()=>{
 for(const candidate of ['sk_live_SYNTHETIC_PRIVATE','not-a-key',undefined]){
  assert.throws(()=>provider(candidate),error=>error.message==='Test secret key required'&&!JSON.stringify(error).includes(String(candidate)));
 }
});
import{createHmac}from'node:crypto';
import{verifyStripe}from'./webhooks.mjs';
test('Stripe raw-payload verifier rejects modified bytes, expired signatures and live events',()=>{
 const secret='synthetic-listener-secret',now=1800000000000,t=String(now/1000);
 const raw=Buffer.from(JSON.stringify({id:'evt_synthetic',livemode:false}));
 const sign=body=>'t='+t+',v1='+createHmac('sha256',secret).update(t+'.').update(body).digest('hex');
 assert.equal(verifyStripe(raw,sign(raw),secret,now).id,'evt_synthetic');
 assert.throws(()=>verifyStripe(Buffer.from(raw+' '),sign(raw),secret,now),/signature refused/);
 assert.throws(()=>verifyStripe(raw,sign(raw),secret,now+301000),/timestamp refused/);
 const live=Buffer.from(JSON.stringify({livemode:true}));assert.throws(()=>verifyStripe(live,sign(live),secret,now),/Non-sandbox/);
});
