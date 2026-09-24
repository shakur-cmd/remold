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
async function test(name, fn) { try { await fn(); console.log('PASS', name); results.push({name,status:'PASS'}); } catch(error) { console.log('RED',name,String(error)); results.push({name,status:'FAIL'}); } }
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
    for (const finality of ['provisional', 'final']) await test('Settled-step ' + finality + ' absence cannot settle a later unresolved step', async () => {
        const f = seed(); await grant(f, 'manager', 'model.call');
        const id = await op(f, 'stale-absence-' + finality, 'manager', 'model.call', 5); await approve(f, id);
        const first = await claim(f, id); await finish(f, id, first, accept(await consume(f, await permit(f, id, first))), 1, true);
        const second = await claim(f, id); await consume(f, await permit(f, id, second));
        await call('unknown', { token: f.A.adapter, id, ...second });
        await reject('resolveUnknown', { token: f.A.adapter, id, ...first, absent: true, finality }, /not unknown/);
        const current = await get(f, id), before = dump(f).orgs.find(o => o._id === f.A.org);
        assert.equal(current.state, 'outcomeUnknown'); assert.equal(current.step, 2);
        assert.equal(before.reserved, 4); assert.equal(before.active, 1); assert.equal(before.spent, 1);
        await call('resolveUnknown', { token: f.A.adapter, id, ...second, absent: true, finality: 'final' });
        await call('resolveUnknown', { token: f.A.adapter, id, ...second, absent: true, finality: 'final' });
        const after = dump(f).orgs.find(o => o._id === f.A.org);
        assert.equal((await get(f, id)).state, 'refused'); assert.equal(after.reserved, 0); assert.equal(after.active, 0); assert.equal(after.spent, 1);
    });
    for (const finality of ['provisional', 'final']) await test('Old consumed fence for the same unresolved step still supports ' + finality + ' absence', async () => {
        const f = seed(); await grant(f); const id = await op(f, 'same-step-' + finality, 'manager', 'marketing.send', 5); await approve(f, id);
        const first = await claim(f, id); await consume(f, await permit(f, id, first));
        await call('unknown', { token: f.A.adapter, id, ...first });
        await call('resolveUnknown', { token: f.A.adapter, id, ...first, absent: true, finality: 'provisional' });
        const second = await claim(f, id); await consume(f, await permit(f, id, second));
        await call('unknown', { token: f.A.adapter, id, ...second });
        assert.notEqual(first.fence, second.fence); assert.equal(first.step, second.step);
        await call('resolveUnknown', { token: f.A.adapter, id, ...first, absent: true, finality });
        if (finality === 'provisional') {
            assert.equal((await get(f, id)).state, 'queued'); assert.equal(dump(f).orgs.find(o => o._id === f.A.org).reserved, 5);
            await call('cancel', { token: f.A.sessions.owner, id });
            await call('resolveUnknown', { token: f.A.adapter, id, ...first, absent: true, finality: 'final' });
        }
        await call('resolveUnknown', { token: f.A.adapter, id, ...second, absent: true, finality: 'final' });
        const after = dump(f).orgs.find(o => o._id === f.A.org);
        assert.equal(after.reserved, 0); assert.equal(after.active, 0); assert.equal(after.spent, 0);
    });

assert.equal(results.filter(r=>r.status==='FAIL').length,2); console.log('TWO OLD-CODE REDS; TWO VALID SAME-STEP CONTROLS PASS');}
try {
    await main();
    writeFileSync('evidence/.run-result.json', JSON.stringify({ code: 0 }));
}
catch (error) {
    console.error(error);
    writeFileSync('evidence/.run-result.json', JSON.stringify({ code: 1, error: String(error) }));
    process.exitCode = 1;
}
