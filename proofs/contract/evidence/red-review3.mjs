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
async function test(name, fn) { try { await fn(); console.log('UNEXPECTED GREEN', name); results.push({name,status:'PASS'}); } catch(error) { console.log('EXPECTED RED',name,String(error)); results.push({name,status:'FAIL'}); } }
async function reject(name, args, pattern) { await assert.rejects(call(name, args), pattern); }
function seed() { const f = cli('seed', { run: randomUUID(), tokens: Array.from({ length: 10 }, () => randomUUID()) }); fixtures.push(f); return f; }
const dump = f => { const data = cli('dump', { orgs: [f.A.org, f.B.org] }), orgs = new Set([f.A.org, f.B.org]), bindings = new Set(data.bindings.filter(b => orgs.has(b.org)).map(b => b._id)), budgets = new Set(data.orgs.filter(o => orgs.has(o._id)).map(o => o.budget)); return Object.fromEntries(Object.entries(data).map(([k, rows]) => [k, rows.filter(r => orgs.has(r.org) || orgs.has(r._id) || budgets.has(r._id) || bindings.has(r.binding))])); };
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
function accept(request) {
    const key = JSON.stringify([request.providerKey, request.key]);
    let receipt = provider.get(key);
    if (!receipt) {
        receipt = { ref: 'fake-' + randomUUID(), calls: 0, payload: request.payload };
        provider.set(key, receipt);
    }
    receipt.calls++;
    return receipt;
}
const finish = (f, id, c, receipt, usage = 1, continuation = false) => call('reconcile', { token: f.A.adapter, id, ...c, providerRef: receipt.ref, usage, continue: continuation });
const fakeKeys = new Map(), remoteState = new Map();
function signed(t, eventId, body) {
    body = JSON.stringify({ channel: 'email', purpose: 'marketing', ...JSON.parse(body) });
    let key = fakeKeys.get(t.binding);
    if (!key) {
        key = randomBytes(32);
        fakeKeys.set(t.binding, key);
    }
    const state = JSON.parse(body), current = remoteState.get(t.binding);
    if (!current || state.version > current.version)
        remoteState.set(t.binding, state);
    return { eventId, body, signature: createHmac('sha256', key).update(eventId + '\n' + body).digest('hex') };
}
async function inbound(t, message) {
    const key = fakeKeys.get(t.binding);
    if (!key)
        throw new Error('untrusted account');
    const expected = createHmac('sha256', key).update(message.eventId + '\n' + message.body).digest();
    const actual = Buffer.from(message.signature, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        throw new Error('invalid fake callback signature');
    return call('callback', { token: t.adapter, binding: t.binding, eventId: message.eventId, body: message.body, observed: remoteState.get(t.binding) });
}
async function main() {
    for (const path of ['sweep', 'expiry', 'failure']) await test('Unresolved consumed attempt survives ' + path + ' and holds global exposure', async () => {
        const f = seed(); await grant(f);
        const id = await op(f, path, 'manager', 'marketing.send', 8); await approve(f, id);
        const c = await claim(f, id), request = await consume(f, await permit(f, id, c));
        await call('unknown', {token:f.A.adapter,id,...c});
        await call('resolveUnknown', {token:f.A.adapter,id,...c,absent:true,finality:'provisional'});
        if (path === 'sweep') await fire(f);
        else {
            const d = await claim(f,id); await permit(f,id,d);
            if (path === 'expiry') { await call('control',{token:f.A.sessions.owner,binding:f.A.binding,healthy:false}); await wait(1400); }
            else await call('fail',{token:f.A.adapter,id,...d,retryable:false});
        }
        assert.equal((await get(f,id)).state,'outcomeUnknown');
        let a = dump(f).orgs.find(o=>o._id===f.A.org); assert.equal(a.reserved,8); assert.equal(a.active,1);
        const b = {...f,A:f.B}; const other = await op(b,'global-blocked','owner','marketing.send',8,{payload:payload('B')}); await approve(b,other);
        await assert.rejects(claim(b,other,'owner'),/global budget/);
        const receipt=accept(request); await finish(f,id,c,receipt,7); await finish(f,id,c,receipt,7);
        a=dump(f).orgs.find(o=>o._id===f.A.org);
        assert.equal((await get(f,id)).state,'confirmed'); assert.equal((await get(f,id)).late,true);
        assert.equal(a.reserved,0); assert.equal(a.active,0); assert.equal(a.spent,7); assert.equal(a.anomaly,undefined);
        await claim(b,other,'owner');
    });
    await test('Cancellation cannot release confirmed work with missing usage', async()=>{
        const f=seed(); await grant(f); const id=await op(f,'missing-cancel','manager','marketing.send',8); await approve(f,id);
        const c=await claim(f,id), receipt=accept(await consume(f,await permit(f,id,c)));
        await call('reconcile',{token:f.A.adapter,id,...c,providerRef:receipt.ref});
        await call('cancel',{token:f.A.sessions.owner,id});
        let a=dump(f).orgs.find(o=>o._id===f.A.org); assert.equal(a.reserved,8); assert.equal(a.active,1);
        const b={...f,A:f.B}, other=await op(b,'global-blocked','owner','marketing.send',8,{payload:payload('B')}); await approve(b,other);
        await assert.rejects(claim(b,other,'owner'),/global budget/);
        await finish(f,id,c,receipt,7); await finish(f,id,c,receipt,7);
        a=dump(f).orgs.find(o=>o._id===f.A.org); assert.equal(a.reserved,0); assert.equal(a.active,0); assert.equal(a.spent,7);
        assert.equal(a.missingUsage,false); await claim(b,other,'owner');
    });
    for(const cancelled of [false,true]) await test('Unconsumed unknown is ignored and scheduler recovers '+cancelled,async()=>{
        const f=seed(); await grant(f); const id=await op(f,'never-sent'); await approve(f,id);
        const c=await claim(f,id); await permit(f,id,c); await call('unknown',{token:f.A.adapter,id,...c});
        if(cancelled) await call('cancel',{token:f.A.sessions.owner,id});
        await wait(1400); const current=await get(f,id); assert.equal(current.state,cancelled?'cancelled':'queued');
        assert.equal(current.consumedPermits.length,0); assert.equal(current.receipts.length,0);
        if(cancelled) assert.equal(dump(f).orgs.find(o=>o._id===f.A.org).active,0);
        else assert.ok(await claim(f,id));
    });
    for(const missing of [false,true]) await test('Single-step accepted overrun remains confirmed '+missing,async()=>{
        const f=seed(); await grant(f); const id=await op(f,'single-overrun'); await approve(f,id);
        const c=await claim(f,id),receipt=accept(await consume(f,await permit(f,id,c)));
        if(missing) await call('reconcile',{token:f.A.adapter,id,...c,providerRef:receipt.ref});
        await finish(f,id,c,receipt,2); await finish(f,id,c,receipt,2);
        assert.equal((await get(f,id)).state,'confirmed'); const a=dump(f).orgs.find(o=>o._id===f.A.org);
        assert.equal(a.spent,2); assert.equal(a.reserved,0); assert.equal(a.active,0); assert.equal(a.anomaly,'usageOverrun');
        const fresh=await op(f,'hold','owner'); await approve(f,fresh); await assert.rejects(claim(f,fresh,'owner'),/anomaly hold/);
    });
    await test('Exhausted successful continuation settles and releases its slot',async()=>{
        const f=seed(); await grant(f,'manager','model.call'); const id=await op(f,'exhausted','manager','model.call',2); await approve(f,id);
        const c=await claim(f,id), receipt=accept(await consume(f,await permit(f,id,c)));
        const result=await finish(f,id,c,receipt,2,true); assert.equal(result.continuationRefused,true);
        assert.equal((await get(f,id)).state,'confirmed'); assert.equal(dump(f).orgs.find(o=>o._id===f.A.org).active,0);
        await assert.rejects(claim(f,id),/released|not claimable/);
    });
    await test('Suppression without an existing purpose/channel row is durable',async()=>{
        const f=seed(); await inbound(f.A,signed(f.A,'new-purpose',JSON.stringify({version:1,state:'suppressed',channel:'sms',purpose:'marketing'})));
        const rows=dump(f).consent.filter(c=>c.org===f.A.org&&c.recipient==='recipient');
        assert.equal(rows.find(c=>c.channel==='sms'&&c.purpose==='marketing')?.suppressed,true);
        assert.equal(rows.find(c=>c.channel==='email'&&c.purpose==='marketing').suppressed,false);
    });

assert.equal(results.filter(r=>r.status==='FAIL').length,10); console.log('TEN REAL OLD-CODE REDS');}
try {
    await main();
    writeFileSync('evidence/.run-result.json', JSON.stringify({ code: 0 }));
}
catch (error) {
    console.error(error);
    writeFileSync('evidence/.run-result.json', JSON.stringify({ code: 1, error: String(error) }));
    process.exitCode = 1;
}
