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
async function test(name, fn) { await fn(); results.push({ name, status: 'PASS', level: 'SERVICE backend / SIM provider and identity' }); console.log('PASS', name); }
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
const consume = (f, p) => { const { expires, ...args } = p; return call('consume', { token: f.A.adapter, ...args }); };
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

let failed=0;
async function red(name,fn){try{await fn();console.log('PASS',name);}catch(error){failed++;console.log('RED',name,String(error));}}
await red('D1 authoritative usage above reservation is recorded and pauses spend',async()=>{const f=seed();await grant(f,'manager','model.call');const id=await op(f,'overrun','manager','model.call',2);await approve(f,id);const c=await claim(f,id),p=await permit(f,id,c),r=accept(await consume(f,p));await finish(f,id,c,r,3);assert.equal((await get(f,id)).overrun,true);});
await red('D1 missing usage blocks already-queued final permit',async()=>{const f=seed();await grant(f);const ids=await Promise.all(['missing','queued'].map(n=>op(f,n)));await Promise.all(ids.map(id=>approve(f,id)));const cs=await Promise.all(ids.map(id=>claim(f,id)));const r=accept(await consume(f,await permit(f,ids[0],cs[0])));await call('reconcile',{token:f.A.adapter,id:ids[0],...cs[0],providerRef:r.ref});await reject('permit',{token:f.A.adapter,id:ids[1],...cs[1],worker:'worker-1'},/usage unresolved/);});
await red('D1 remaining exposure exhausted blocks next model permit',async()=>{const f=seed();await grant(f,'manager','model.call');const id=await op(f,'exhaust','manager','model.call',1);await approve(f,id);const c=await claim(f,id),r=accept(await consume(f,await permit(f,id,c)));await finish(f,id,c,r,1,true);const next=await claim(f,id);await reject('permit',{token:f.A.adapter,id,...next,worker:'worker-1'},/exposure exhausted/);});
await red('D2 accepted consumed tail remains recordable after absence and firing',async()=>{const f=seed();await grant(f);const id=await op(f,'late');await approve(f,id);const c=await claim(f,id),request=await consume(f,await permit(f,id,c));await call('unknown',{token:f.A.adapter,id,...c});await fire(f);await call('resolveUnknown',{token:f.A.adapter,id,...c,absent:true});await finish(f,id,c,accept(request));assert.equal((await get(f,id)).state,'confirmed');});
await red('D3 callback on unrelated contact does not suppress literal fixture recipient',async()=>{const f=seed();const intent=await call('provision',{token:f.A.sessions.owner,binding:f.A.binding,intent:'different-contact',remove:false});const binding=await call('bind',{token:f.A.adapter,intent,kind:'contact',externalId:'Y',local:'recipient-Y'});await call('callback',{token:f.A.adapter,binding,eventId:'Y-suppress',body:JSON.stringify({version:1,state:'suppressed'})});assert.equal(dump(f).consent.find(c=>c.org===f.A.org&&c.recipient==='recipient').suppressed,false);});
await red('D5 server recovers consumed crash without adapter calling expire',async()=>{const f=seed();await grant(f);const id=await op(f,'server-expire');await approve(f,id);const c=await claim(f,id);await consume(f,await permit(f,id,c));await wait(2500);assert.equal((await get(f,id)).state,'outcomeUnknown');});
for(const path of ['rejection','absence','expiry','continue'])await red('durable cancel '+path,async()=>{const f=seed(),cap=path==='continue'?'model.call':'marketing.send';await grant(f,'manager',cap);const id=await op(f,path,'manager',cap,3);await approve(f,id);const c=await claim(f,id),p=await permit(f,id,c),request=path==='expiry'?null:await consume(f,p);await call('cancel',{token:f.A.sessions.owner,id});if(path==='rejection')await call('fail',{token:f.A.adapter,id,...c,retryable:true});if(path==='absence'){await call('unknown',{token:f.A.adapter,id,...c});await call('resolveUnknown',{token:f.A.adapter,id,...c,absent:true});}if(path==='expiry'){await wait(1200);await call('expire',{token:f.A.adapter,id});}if(path==='continue')await finish(f,id,c,accept(request),1,true);await assert.rejects(claim(f,id),/cancel|not claimable/);});
console.log('D4 status API is absent; no missing-function failure is counted as a behavior red. T1/T2 will get negative mutation controls.');console.log(failed,'actual behavior reds');writeFileSync('evidence/.run-result.json',JSON.stringify({code:1}));process.exitCode=1;
