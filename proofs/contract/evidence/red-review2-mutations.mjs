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
function signed(t, eventId, body) { body=JSON.stringify({channel:'email',purpose:'marketing',...JSON.parse(body)}); let key = fakeKeys.get(t.binding); if (!key) {
    key = randomBytes(32);
    fakeKeys.set(t.binding, key);
} const state = JSON.parse(body), current = remoteState.get(t.binding); if (!current || state.version > current.version)
    remoteState.set(t.binding, state); return { eventId, body, signature: createHmac('sha256', key).update(eventId + '\n' + body).digest('hex') }; }
async function inbound(t, message) { const key = fakeKeys.get(t.binding); if (!key)
    throw new Error('untrusted account'); const expected = createHmac('sha256', key).update(message.eventId + '\n' + message.body).digest(); const actual = Buffer.from(message.signature, 'hex'); if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error('invalid fake callback signature'); return call('callback', { token: t.adapter, binding: t.binding, eventId: message.eventId, body: message.body, observed: remoteState.get(t.binding) }); }

let failures=0;
async function red(name,fn){try{await fn();console.log('UNEXPECTED PASS',name);}catch(error){failures++;console.log('RED',name,String(error));}}
await red('T1 removing object check leaks invoice through records-all person grant',async()=>{const f=seed();await grant(f,'manager','read',{scope:{kind:'records',object:'person',records:'all',fields:['public']}});assert.deepEqual(await read('read',{token:f.A.sessions.manager,surface:'export'}),[{public:'visible A'}]);});
await red('T2 removing grantor epoch check leaves descendant reads after manager downgrade',async()=>{const f=seed();await manage(f);const root=await grant(f),readRoot=await grant(f,'manager','read',{scope:{kind:'records',object:'person',records:'all',fields:['public']}});await call('grant',{token:f.A.sessions.manager,target:f.A.actors.child,parent:readRoot,capability:'read',scope:{kind:'records',object:'person',records:'all',fields:['public']},mode:'propose',delegate:false,expires:Date.now()+30000});await call('revokeGrant',{token:f.A.sessions.owner,id:root});assert.deepEqual(await read('read',{token:f.A.sessions.child,surface:'export'}),[]);});
await red('D4 a false cancellation signal is detected by adapter-status probe',async()=>{const f=seed();await grant(f);const id=await op(f,'cancel-signal');await approve(f,id);const c=await claim(f,id);await permit(f,id,c);await fire(f);assert.equal((await read('adapterStatus',{token:f.A.adapter,id,...c})).cancel,true);});
console.log(failures,'mutation behavior reds');writeFileSync('evidence/.run-result.json',JSON.stringify({code:1}));process.exitCode=1;
