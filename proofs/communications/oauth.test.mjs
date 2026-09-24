import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OAuthConnections, MAILBOXES, SCOPES } from './oauth.mjs';
function fixture(overrides={}) {
  let auth, exchanges=0;const stored=[];
  const f=new OAuthConnections({clientId:'synthetic-client',exchange:async()=>{exchanges++;return{id_token:'synthetic',access_token:'synthetic',refresh_token:'synthetic',scope:SCOPES.join(' ')}},verify:async()=>({nonce:auth.searchParams.get('nonce'),sub:'subject-A',email_verified:true,email:MAILBOXES.A}),profile:async()=>({emailAddress:MAILBOXES.A,historyId:'90071992547410000'}),persist:async c=>stored.push(c),...overrides});
  const begin=(session='browser-A')=>{auth=new URL(f.begin('A',session));return{state:auth.searchParams.get('state'),code:'synthetic-code',session}};
  return{f,begin,stored,authorization:()=>auth,exchanges:()=>exchanges};
}
test('OAuth requires browser-bound state and consumes it once before exchanging code',async()=>{
  const x=fixture(), args=x.begin();
  await assert.rejects(x.f.complete({...args,session:'browser-B'}),/INVALID_STATE/);assert.equal(x.exchanges(),0);
  const result=await x.f.complete(args);assert.equal(result.connected,true);assert.equal(result.sendAllowance,0);
  await assert.rejects(x.f.complete(args),/INVALID_STATE/);assert.equal(x.exchanges(),1);
  assert.equal(x.stored[0].cursor,'90071992547410000');
});
test('concurrent callback replay only exchanges one code',async()=>{
  const x=fixture(),args=x.begin();const result=await Promise.allSettled([x.f.complete(args),x.f.complete(args)]);
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(x.exchanges(),1);
});
test('expired state and denied consent cannot exchange an authorization code',async()=>{
  let now=100;const x=fixture({now:()=>now}),args=x.begin();now+=600001;
  await assert.rejects(x.f.complete(args),/INVALID_STATE/);assert.equal(x.exchanges(),0);
  const denied=x.begin();await assert.rejects(x.f.complete({...denied,error:'access_denied'}),/OAUTH_DENIED/);
  await assert.rejects(x.f.complete(denied),/INVALID_STATE/);assert.equal(x.exchanges(),0);
});
test('verified identity mismatch, wrong nonce and mailbox mismatch never persist credentials',async()=>{
  for(const override of [
    {verify:async()=>({sub:'other',email_verified:true,email:MAILBOXES.B,nonce:'wrong'})},
    {profile:async()=>({emailAddress:MAILBOXES.B,historyId:'22'})},
    {exchange:async()=>({id_token:'synthetic',access_token:'synthetic',refresh_token:'synthetic',scope:'openid email'})},
  ]){const x=fixture(override);await assert.rejects(x.f.complete(x.begin()),/MISMATCH|SCOPE_MISSING/);assert.equal(x.stored.length,0);}
});
test('reconnect preserves cursor and refuses a different Google subject for same slot',async()=>{
  const x=fixture({existing:{A:{subject:'subject-A',cursor:'100',tokens:{refresh_token:'old'}}}});
  await x.f.complete(x.begin());assert.equal(x.stored[0].cursor,'100');
  const y=fixture({existing:{A:{subject:'other-subject',cursor:'100'}}});
  await assert.rejects(y.f.complete(y.begin()),/ACCOUNT_SWITCH_REFUSED/);assert.equal(y.stored.length,0);
});
test('nonce and email verification are checked independently of a correct email address',async()=>{
  for(const patch of [{nonce:'wrong'},{email_verified:false}]){
    const x=fixture(),args=x.begin();
    x.f.verify=async()=>({nonce:x.authorization().searchParams.get('nonce'),sub:'subject-A',email_verified:true,email:MAILBOXES.A,...patch});
    await assert.rejects(x.f.complete(args),/ACCOUNT_MISMATCH/);assert.equal(x.stored.length,0);
  }
});
test('authorization URL requests authorized Gmail send plus read scope with PKCE and no calendar',()=>{
  const x=fixture();const u=new URL(x.f.begin('A','browser-A'));
  assert.equal(u.searchParams.get('login_hint'),MAILBOXES.A);assert.equal(u.searchParams.get('code_challenge_method'),'S256');
  assert.equal(u.searchParams.get('scope'),SCOPES.join(' '));assert.ok(u.searchParams.get('scope').includes('gmail.send'));assert.ok(!u.searchParams.get('scope').match(/compose|calendar/));assert.equal(u.searchParams.get('include_granted_scopes'),'true');
});

test('mailbox A refuses a partial grant missing send permission',async()=>{const x=fixture({exchange:async()=>({id_token:'synthetic',access_token:'synthetic',refresh_token:'synthetic',scope:'openid email https://www.googleapis.com/auth/gmail.readonly'})});await assert.rejects(x.f.complete(x.begin()),/MAIL_SCOPE_MISSING/);assert.equal(x.stored.length,0);});

test('profile failure retains a verified private candidate and read-only retry does not exchange again',async()=>{
  let available=false;const candidates=[];
  const x=fixture({profile:async()=>{if(!available)throw new Error('PROFILE_UNAVAILABLE');return{emailAddress:MAILBOXES.A,historyId:'777'}},persistCandidate:async c=>candidates.push(c)});
  await assert.rejects(x.f.complete(x.begin()),/PROFILE_UNAVAILABLE/);
  assert.equal(candidates.length,1);assert.equal(candidates[0].tokens.refresh_token,'synthetic');assert.equal(x.f.connections.size,0);
  available=true;const result=await x.f.retryProfile('A');assert.equal(result.connected,true);assert.equal(x.exchanges(),1);assert.equal(x.stored[0].cursor,'777');
});
test('calendar consent is opt-in and partial calendar grants cannot authorize the fixture',async()=>{
 const scope='https://www.googleapis.com/auth/calendar.events.owned';
 const missing=fixture({calendarProof:true});const args=missing.begin();
 assert.ok(missing.authorization().searchParams.get('scope').split(' ').includes(scope));
 await assert.rejects(missing.f.complete(args),/CALENDAR_SCOPE_MISSING/);
 const complete=fixture({calendarProof:true,exchange:async()=>({id_token:'synthetic',access_token:'synthetic',refresh_token:'synthetic',scope:[...SCOPES,scope].join(' ')})});
 assert.equal((await complete.f.complete(complete.begin())).calendarAuthorized,true);
});
