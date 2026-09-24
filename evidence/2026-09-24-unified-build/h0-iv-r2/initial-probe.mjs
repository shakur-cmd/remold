import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID, randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ConvexHttpClient } from 'convex/browser';
import { api } from './convex/_generated/api.js';
const url = readFileSync('.env.local', 'utf8').match(/^CONVEX_URL=(.+)$/m)?.[1];
if (url !== 'http://127.0.0.1:3410')
    throw new Error('Proof refuses unexpected target');
const client = new ConvexHttpClient(url, { logger: false });
const call = (name, args) => client.mutation(api.harness[name], args);
const read = (name, args) => client.query(api.harness[name], args);
const cli = (name, args) => JSON.parse(execFileSync(process.execPath, ['../../node_modules/convex/bin/main.js', 'run', 'harness:' + name, JSON.stringify(args)], { encoding: 'utf8' }));
const fixtures = [], results = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
async function test(name, fn) { try { await fn(); results.push({name,status:'PASS'});console.log('PASS',name); } catch(error) {results.push({name,status:'FAIL',error:String(error)});console.error('FAIL',name,String(error));} }
async function reject(name, args, pattern) { await assert.rejects(call(name, args), pattern); }
function seed() { const f = cli('seed', { run: randomUUID(), tokens: Array.from({length:10},()=>randomUUID()) }); fixtures.push(f); return f; }
const dump = f => { const data = cli('dump', {orgs:[f.A.org,f.B.org]}), orgs = new Set([f.A.org, f.B.org]), bindings = new Set(data.bindings.filter(b => orgs.has(b.org)).map(b => b._id)), budgets = new Set(data.orgs.filter(o => orgs.has(o._id)).map(o => o.budget)); return Object.fromEntries(Object.entries(data).map(([k, rows]) => [k, rows.filter(r => orgs.has(r.org) || orgs.has(r._id) || budgets.has(r._id) || bindings.has(r.binding))])); };
const payload = (account = 'A', amountMinor = 100) => ({ content: 'synthetic content', audience: ['recipient'], audienceVersion: 1, destination: account, schedule: 0, amountMinor, currency: 'USD', workflowVersion: 1 });
const bindingScope = (t, extra = {}) => ({ kind: 'bindings', bindings: [t.binding], maxAmountMinor: 1000, currency: 'USD', maxRecipients: 1, ...extra });
const modelScope = { kind: 'model', maxUnitsPerRun: 8, maxSteps: 3 };
async function grant(f, who = 'manager', capability = 'marketing.send', extra = {}) { return call('grant', { token: f.A.sessions.owner, target: f.A.actors[who], capability, scope: capability === 'model.call' ? modelScope : bindingScope(f.A), mode: 'propose', delegate: true, expires: Date.now() + 60000, ...extra }); }
async function manage(f, who = 'manager', targets = ['child']) { return grant(f, who, 'agent.manage', { scope: { kind: 'agents', agents: targets.map(n => f.A.actors[n]) }, mode: 'direct' }); }
async function op(f, logical, who = 'manager', capability = 'marketing.send', units = 1, extra = {}) { return call('propose', { token: f.A.sessions[who], logical, binding: f.A.binding, capability, payload: payload(), reservationUnits: units, maxSteps: capability === 'model.call' ? 3 : 1, ...extra }); }
async function approve(f, id) { return call('approve', { token: f.A.sessions.owner, id, expires: Date.now() + 60000 }); }
const claim = (f, id, who = 'manager', worker = 'worker-1') => call('claim', { token: f.A.sessions[who], id, worker });
const permit = (f, id, c, worker = 'worker-1') => call('permit', { token: f.A.adapter, id, ...c, worker });
const consume = (f, p) => { const { expires, maxUnits, maxRecipients, ...args } = p; return call('consume', { token: f.A.adapter, ...args }); };
const fire = (f, who = 'manager') => call('revoke', { token: f.A.sessions.owner, target: f.A.actors[who] });
const get = (f, id) => read('operation', { token: f.A.sessions.owner, id });
const provider = new Map();
function accept(request) { const key = JSON.stringify([request.providerKey, request.key]); let receipt = provider.get(key); if (!receipt) {
    receipt = { ref: 'fake-' + randomUUID(), calls: 0, payload: request.payload };
    provider.set(key, receipt);
} receipt.calls++; return receipt; }
const finish = (f, id, c, receipt, usage = 1, continuation = false) => call('reconcile', { token: f.A.adapter, id, ...c, providerRef: receipt.ref, usage, continue: continuation });
const fakeKeys = new Map(), remoteState = new Map();
function signed(t, eventId, body) { let key = fakeKeys.get(t.binding); if (!key) {
    key = randomBytes(32);
    fakeKeys.set(t.binding, key);
} const state = JSON.parse(body), current = remoteState.get(t.binding); if (!current || state.version > current.version)
    remoteState.set(t.binding, state); return { eventId, body, signature: createHmac('sha256', key).update(eventId + '\n' + body).digest('hex') }; }
async function inbound(t, message) { const key = fakeKeys.get(t.binding); if (!key)
    throw new Error('untrusted account'); const expected = createHmac('sha256', key).update(message.eventId + '\n' + message.body).digest(); const actual = Buffer.from(message.signature, 'hex'); if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error('invalid fake callback signature'); return call('callback', { token: t.adapter, binding: t.binding, eventId: message.eventId, body: message.body, observed: remoteState.get(t.binding) }); }
async function main(){
await test('New external/event ID collisions remain separated by tenant account and resource kind',async()=>{
 const f=seed(),created={};
 for(const name of ['A','B']){const t=f[name],intent=await call('provision',{token:t.sessions.owner,binding:t.binding,intent:'iv-intent',remove:false});
 created[name]=await call('bind',{token:t.adapter,intent,kind:'iv-kind',externalId:'collision-IV-97',local:'recipient'});
 assert.equal(await call('bind',{token:t.adapter,intent,kind:'iv-kind',externalId:'collision-IV-97',local:'recipient'}),created[name]);
 await reject('bind',{token:t.adapter,intent,kind:'iv-kind',externalId:'collision-IV-97',local:'iv-wrong'},/binding collision/);
 assert.notEqual(await call('bind',{token:t.adapter,intent,kind:'other-kind',externalId:'collision-IV-97',local:'recipient'}),created[name]);}
 assert.notEqual(created.A,created.B);
 const callback=(t,binding,state,version)=>call('callback',{token:t.adapter,binding,eventId:'shared-event-IV97',body:JSON.stringify({version,state,channel:'email',purpose:'marketing'})});
 assert.equal(await callback(f.A,created.A,'suppressed',17),'applied');assert.equal(await callback(f.B,created.B,'subscribed',19),'applied');assert.equal(await callback(f.A,created.A,'suppressed',17),'duplicate');
 await assert.rejects(callback(f.A,created.B,'suppressed',17),/adapter scope/);
 const data=dump(f);assert.equal(data.callbacks.filter(x=>x.eventId==='shared-event-IV97').length,2);assert.equal(data.consent.find(x=>x.org===f.A.org).suppressed,true);assert.equal(data.consent.find(x=>x.org===f.B.org).suppressed,false);
});
await test('Delegated grant revoked on either side of permit produces refusal or one late result',async()=>{
 for(const after of [false,true]){const f=seed();await manage(f);const parent=await grant(f);
 await call('grant',{token:f.A.sessions.manager,target:f.A.actors.child,parent,capability:'marketing.send',scope:bindingScope(f.A),mode:'propose',delegate:false,expires:Date.now()+30000});
 const id=await op(f,'iv-cut-'+after,'child');await approve(f,id);const c=await claim(f,id,'child','iv-worker');const p=after?await permit(f,id,c,'iv-worker'):null;
 await call('revokeGrant',{token:f.A.sessions.owner,id:parent});
 if(!p){await reject('permit',{token:f.A.adapter,id,...c,worker:'iv-worker'},/stale claim|authority/);assert.equal((await get(f,id)).state,'paused');assert.equal(dump(f).orgs.find(x=>x._id===f.A.org).reserved,0);}
 else{assert.equal((await get(f,id)).state,'cancellationPending');const req=await consume(f,p);await assert.rejects(consume(f,p),/invalid or spent/);await finish(f,id,c,accept(req));assert.equal((await get(f,id)).late,true);}}
});
await test('Concurrent permits stay bounded and post-claim suppression blocks the losing dispatch',async()=>{
 const f=seed();await grant(f);const ids=await Promise.all(['iv-race1','iv-race2'].map(x=>op(f,x)));await Promise.all(ids.map(id=>approve(f,id)));const cs=await Promise.all(ids.map(id=>claim(f,id)));
 const ps=await Promise.allSettled(ids.map((id,i)=>permit(f,id,cs[i])));assert.equal(ps.filter(x=>x.status==='fulfilled').length,1);const loser=ps.findIndex(x=>x.status==='rejected');await call('control',{token:f.A.sessions.owner,suppress:true,recipient:'recipient'});await reject('permit',{token:f.A.adapter,id:ids[loser],...cs[loser],worker:'worker-1'},/consent denied/);
 const p=ps.find(x=>x.status==='fulfilled').value;await finish(f,p.id,cs[ids.indexOf(p.id)],accept(await consume(f,p)));assert.equal(dump(f).operations.filter(x=>x.state==='confirmed').length,1);
});
await test('Old worker cannot permit or reconcile after lease expiry and new claim',async()=>{
 const f=seed();await grant(f);const id=await op(f,'iv-stale');await approve(f,id);const old=await claim(f,id,'manager','old');await wait(2100);const fresh=await claim(f,id,'manager','fresh');assert.ok(fresh.fence>old.fence);await reject('permit',{token:f.A.adapter,id,...old,worker:'old'},/stale claim/);
 const r=accept(await consume(f,await permit(f,id,fresh,'fresh')));await reject('reconcile',{token:f.A.adapter,id,...old,providerRef:r.ref,usage:1},/stale/);await finish(f,id,fresh,r);
});
await test('Eight real concurrent claims keep both tenant and global caps',async()=>{
 const f=seed(),req=[];for(const name of ['A','B'])for(let i=0;i<4;i++){const t=f[name],id=await call('propose',{token:t.sessions.owner,logical:'iv-'+i,binding:t.binding,capability:'model.call',payload:payload(name),reservationUnits:3,maxSteps:2});await call('approve',{token:t.sessions.owner,id,expires:Date.now()+60000});req.push({token:t.sessions.owner,id,worker:name+i});}
 const claims=await Promise.allSettled(req.map(x=>call('claim',x)));assert.equal(claims.filter(x=>x.status==='fulfilled').length,3);const d=dump(f);assert.equal(d.budgets[0].reserved,9);assert.equal(d.budgets[0].active,3);for(const o of d.orgs){assert.ok(o.active<=2);assert.ok(o.reserved+o.spent<=o.cap);}
});
for(const path of ['rejection','absence'])await test('Cancellation survives provider '+path+' without a new permit',async()=>{
 const f=seed();await grant(f);const id=await op(f,'iv-cancel-'+path);await approve(f,id);const c=await claim(f,id),p=await permit(f,id,c);await consume(f,p);await call('cancel',{token:f.A.sessions.owner,id});assert.equal((await get(f,id)).state,'cancellationPending');
 if(path==='rejection')await call('fail',{token:f.A.adapter,id,...c,retryable:true});else{await call('unknown',{token:f.A.adapter,id,...c});await call('resolveUnknown',{token:f.A.adapter,id,...c,absent:true,finality:'provisional'});}
 const state=(await get(f,id)).state;console.log('CANCEL_OBSERVED',path,state);
 let issued=false;try{const next=await claim(f,id);await permit(f,id,next);issued=true;}catch{}
 assert.equal(issued,false,'Cancellation must never authorize another provider attempt; observed '+state);
});

for(const path of ['unconsumed expiry','model continuation'])await test('Cancellation survives '+path+' without a new permit',async()=>{
 const f=seed(),model=path==='model continuation',capability=model?'model.call':'marketing.send';await grant(f,'manager',capability);const id=await op(f,'iv-cancel-'+path,'manager',capability,model?4:1);await approve(f,id);const c=await claim(f,id),p=await permit(f,id,c);const req=model?await consume(f,p):null;await call('cancel',{token:f.A.sessions.owner,id});
 if(model)await finish(f,id,c,accept(req),1,true);else{await wait(1150);await call('expire',{token:f.A.adapter,id});}
 const state=(await get(f,id)).state;console.log('CANCEL_OBSERVED',path,state);let issued=false;try{const next=await claim(f,id);await permit(f,id,next);issued=true;}catch{}
 assert.equal(issued,false,'Cancellation must never authorize another provider attempt; observed '+state);
});
await test('Accepted pre-cancel permit tail is recorded as completed after cancellation',async()=>{
 const f=seed();await grant(f);const id=await op(f,'iv-cancel-tail');await approve(f,id);const c=await claim(f,id),p=await permit(f,id,c);await call('cancel',{token:f.A.sessions.owner,id});const req=await consume(f,p);await finish(f,id,c,accept(req));const result=await get(f,id),events=dump(f).events.filter(x=>x.resource===id);console.log('CANCEL_TAIL_OBSERVED',JSON.stringify({state:result.state,late:result.late,events}));assert.equal(result.late,true,'Accepted in-flight tail must retain canceled status in outcome');
});

await test('Exposure bounds, overrun truth and already-queued spend holds',async()=>{
 const f=seed();await grant(f,'manager','model.call');
 const id=await op(f,'iv-overrun','manager','model.call',6),waiting=await op(f,'iv-already-queued','owner');await approve(f,id);await approve(f,waiting);const c=await claim(f,id),wc=await claim(f,waiting,'owner');
 const p=await permit(f,id,c);assert.equal(p.maxUnits,6);assert.equal(p.maxRecipients,1);const req=await consume(f,p);assert.equal(req.maxUnits,6);const r=accept(req);await finish(f,id,c,r,4,true);
 const n=await claim(f,id),p2=await permit(f,id,n);assert.equal(p2.maxUnits,2);const r2=accept(await consume(f,p2));await finish(f,id,n,r2,5,true);await finish(f,id,n,r2,5,true);
 const d=dump(f),org=d.orgs.find(x=>x._id===f.A.org),res=await get(f,id);assert.equal(res.overrun,true);assert.equal(res.usage,9);assert.equal(org.spent,9);assert.equal(org.reserved,1);assert.equal(org.active,1);assert.equal(org.anomaly,'usageOverrun');assert.equal(res.receipts.length,2);
 await reject('permit',{token:f.A.adapter,id:waiting,...wc,worker:'worker-1'},/anomaly hold/);
 await reject('claim',{token:f.A.sessions.owner,id:waiting,worker:'new'},/anomaly hold|lease/);
 const g=seed();await grant(g,'manager','model.call');const ex=await op(g,'iv-exhaust','manager','model.call',3);await approve(g,ex);const ec=await claim(g,ex);await finish(g,ex,ec,accept(await consume(g,await permit(g,ex,ec))),3,true);const nc=await claim(g,ex);await reject('permit',{token:g.A.adapter,id:ex,...nc,worker:'worker-1'},/exposure exhausted/);
});
await test('Unknown usage prevents an already queued permit and resolves idempotently',async()=>{
 const f=seed();await grant(f);const a=await op(f,'iv-missing','manager','marketing.send',2),b=await op(f,'iv-waiting');await approve(f,a);await approve(f,b);const ca=await claim(f,a),cb=await claim(f,b),r=accept(await consume(f,await permit(f,a,ca)));
 await call('reconcile',{token:f.A.adapter,id:a,...ca,providerRef:r.ref});await reject('permit',{token:f.A.adapter,id:b,...cb,worker:'worker-1'},/usage unresolved/);assert.equal(dump(f).orgs.find(x=>x._id===f.A.org).reserved,3);
 await finish(f,a,ca,r,1);await finish(f,a,ca,r,1);const org=dump(f).orgs.find(x=>x._id===f.A.org);assert.equal(org.spent,1);assert.equal(org.reserved,1);assert.equal(org.missingUsage,false);await permit(f,b,cb);
});
await test('Old consumed receipts survive provisional/final absence and conflicting receipt cannot double-charge',async()=>{
 for(const finality of ['provisional','final']){const f=seed();await grant(f);const id=await op(f,'iv-late-'+finality,'manager','marketing.send',3);await approve(f,id);const c=await claim(f,id),req=await consume(f,await permit(f,id,c));await call('unknown',{token:f.A.adapter,id,...c});await fire(f);await call('resolveUnknown',{token:f.A.adapter,id,...c,absent:true,finality});
 assert.equal(dump(f).orgs.find(x=>x._id===f.A.org).reserved,finality==='final'?0:3);const r=accept(req);await finish(f,id,c,r,2);await finish(f,id,c,r,2);const result=await get(f,id),org=dump(f).orgs.find(x=>x._id===f.A.org);assert.equal(result.state,'confirmed');assert.equal(result.late,true);assert.equal(result.receipts.length,1);assert.equal(org.spent,2);assert.equal(org.reserved,0);assert.equal(org.active,0);assert.equal(r.calls,1);if(finality==='final')assert.equal(org.anomaly,'acceptedAfterFinalAbsence');
 const collision=await call('reconcile',{token:f.A.adapter,id,...c,providerRef:'iv-contradictory-receipt-'+finality,usage:7});assert.equal(collision.accepted,false);assert.equal(dump(f).orgs.find(x=>x._id===f.A.org).spent,2);assert.equal((await get(f,id)).receipts.length,1);}
});
await test('Recipient Y callback blocks only Y, purpose/channel and same external ID tenant collisions remain isolated',async()=>{
 const f=seed();await grant(f,'manager','marketing.send',{scope:bindingScope(f.A,{bindings:[f.A.binding,f.A.bindingY]})});const x=await op(f,'iv-X'),y=await op(f,'iv-Y','manager','marketing.send',1,{binding:f.A.bindingY,payload:{...payload(),audience:['recipient-Y']}});await approve(f,x);await approve(f,y);const cx=await claim(f,x),cy=await claim(f,y);
 const cb=(t,binding,eventId,version,purpose,channel)=>call('callback',{token:t.adapter,binding,eventId,body:JSON.stringify({version,state:'suppressed',purpose,channel})});
 await cb(f.A,f.A.bindingY,'iv-Y-email',41,'marketing','email');await reject('permit',{token:f.A.adapter,id:y,...cy,worker:'worker-1'},/consent denied/);
 await cb(f.A,f.A.binding,'iv-X-sms',42,'marketing','sms');await cb(f.A,f.A.binding,'iv-X-transactional',43,'transactional','email');
 const before=dump(f).consent.filter(x=>x.org===f.A.org);await cb(f.B,f.B.bindingY,'iv-Y-email',41,'marketing','email');assert.deepEqual(dump(f).consent.filter(x=>x.org===f.A.org),before);
 const r=accept(await consume(f,await permit(f,x,cx)));await finish(f,x,cx,r);assert.equal((await get(f,x)).state,'confirmed');assert.equal(before.find(x=>x.recipient==='recipient').suppressed,false);
});
await test('Adapter cancellation signal is current, fenced and account-scoped',async()=>{
 for(const cut of ['cancel','fire','grant']){const f=seed(),g=await grant(f);const id=await op(f,'iv-signal-'+cut);await approve(f,id);const c=await claim(f,id);await permit(f,id,c);assert.equal((await read('adapterStatus',{token:f.A.adapter,id,...c})).cancel,false);
 if(cut==='cancel')await call('cancel',{token:f.A.sessions.owner,id});else if(cut==='fire')await fire(f);else await call('revokeGrant',{token:f.A.sessions.owner,id:g});
 assert.equal((await read('adapterStatus',{token:f.A.adapter,id,...c})).cancel,true);await assert.rejects(read('adapterStatus',{token:f.B.adapter,id,...c}),/adapter scope/);await assert.rejects(read('adapterStatus',{token:f.A.adapter,id,fence:c.fence+99,step:c.step}),/stale status/);}
});
await test('Real server expiry frees permit slot without the crashed adapter and preserves consumed reservation',async()=>{
 for(const used of [false,true]){const f=seed();await grant(f);const id=await op(f,'iv-crash-'+used),next=await op(f,'iv-after-crash');await approve(f,id);await approve(f,next);const c=await claim(f,id),p=await permit(f,id,c);if(used)await consume(f,p);await wait(2600);
 const result=await get(f,id);assert.equal(result.state,used?'outcomeUnknown':'queued');const d=dump(f);assert.ok(d.events.some(e=>e.resource===id&&e.actor==='system-expiry'));assert.equal(d.orgs.find(x=>x._id===f.A.org).reserved,1);const n=await claim(f,next);await permit(f,next,n);}
});
await test('Object wildcard is still object-specific and manager grant downgrade strips child lineage only',async()=>{
 const f=seed();await manage(f);const send=await grant(f),model=await grant(f,'manager','model.call'),rs={kind:'records',object:'person',records:'all',fields:['public']},rg=await grant(f,'manager','read',{scope:rs});
 for(const [parent,capability,scope] of [[send,'marketing.send',bindingScope(f.A)],[model,'model.call',modelScope],[rg,'read',rs]])await call('grant',{token:f.A.sessions.manager,target:f.A.actors.child,parent,capability,scope,mode:'propose',delegate:false,expires:Date.now()+30000});
 for(const surface of ['record','history','MCP','REST','export','report','file','provider','subscription']){const result=await read('read',{token:f.A.sessions.child,surface});assert.equal(result.length,1);assert.ok(!JSON.stringify(result).includes('secret'));}
 const queued=await op(f,'iv-delegated','child'),modelNext=await op(f,'iv-model-child','child','model.call');await approve(f,queued);await approve(f,modelNext);const c=await claim(f,queued,'child');await grant(f,'child','billing.refund');const independent=await op(f,'iv-independent-refund','child','billing.refund');await approve(f,independent);
 await call('revokeGrant',{token:f.A.sessions.owner,id:rg});await reject('permit',{token:f.A.adapter,id:queued,...c,worker:'worker-1'},/stale claim|authority/);await assert.rejects(claim(f,modelNext,'child'),/not claimable|authority/);assert.deepEqual(await read('read',{token:f.A.sessions.child,surface:'export'}),[]);assert.ok(await claim(f,independent,'child'));
});

writeFileSync('evidence/independent-fixtures.json',JSON.stringify(fixtures.map(dump),null,2));writeFileSync('evidence/independent-results.json',JSON.stringify({manifest:'9a316dc7d28ecf127c83b566f6ddb384b3d6bc80fadc24425dd79c199cb41cdf',level:'SERVICE backend / SIM identity and providers',results},null,2));
}
try{await main();const code=results.some(x=>x.status==='FAIL')?1:0;writeFileSync('evidence/.run-result.json',JSON.stringify({code}));process.exitCode=code;}catch(error){console.error(error);writeFileSync('evidence/.run-result.json',JSON.stringify({code:1,error:String(error)}));process.exitCode=1;}
