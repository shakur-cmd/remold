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
    await test('A/B known-ID isolation, server-derived actors and full binding tuple collision', async () => {
        const f = seed(), before = dump(f);
        const id = await op(f, 'default');
        await approve(f, id);
        await reject('claim', { token: f.A.sessions.manager, id, worker: 'w' }, /authority denied/);
        await reject('approve', { token: f.B.sessions.owner, id, expires: Date.now() + 1000 }, /tenant denied/);
        await reject('claim', { token: f.B.sessions.manager, id, worker: 'w' }, /tenant denied/);
        await assert.rejects(read('operation', { token: f.B.sessions.owner, id }), /tenant denied/);
        await reject('revoke', { token: f.B.sessions.manager, target: f.A.actors.manager }, /tenant denied/);
        await reject('propose', { token: f.A.sessions.manager, actor: f.B.actors.owner, logical: 'forged', binding: f.A.binding, capability: 'marketing.send', payload: payload(), reservationUnits: 1, maxSteps: 1 }, /extra field/);
        await grant(f);
        const c = await claim(f, id), p = await permit(f, id, c);
        await finish(f, id, c, accept(await consume(f, p)));
        assert.equal((await get(f, id)).state, 'confirmed');
        const after = dump(f);
        for (const table of Object.keys(before))
            assert.deepEqual(after[table].filter(x => x.org === f.B.org || x._id === f.B.org), before[table].filter(x => x.org === f.B.org || x._id === f.B.org));
        assert.equal(before.bindings.find(b => b._id === f.A.binding).externalId, before.bindings.find(b => b._id === f.B.binding).externalId);
        assert.notEqual(before.bindings.find(b => b._id === f.A.binding).account, before.bindings.find(b => b._id === f.B.binding).account);
        const intent = await call('provision', { token: f.A.sessions.owner, binding: f.A.binding, intent: 'binding', remove: false });
        const binding = before.bindings.find(b => b._id === f.A.binding);
        assert.equal(await call('bind', { token: f.A.adapter, intent, kind: binding.kind, externalId: binding.externalId, local: binding.local }), f.A.binding);
        await reject('bind', { token: f.A.adapter, intent, kind: binding.kind, externalId: binding.externalId, local: 'different' }, /binding collision/);
        await reject('bind', { token: f.A.adapter, intent, kind: 'contact', externalId: '1', local: 'foreign', org: f.B.org }, /extra field/);
    });
    await test('Grant scopes reject foreign bindings, currencies, record masks and unrelated delegation', async () => {
        const f = seed();
        await reject('grant', { token: f.A.sessions.owner, target: f.A.actors.manager, capability: 'marketing.send', scope: bindingScope(f.B), mode: 'direct', delegate: false, expires: Date.now() + 10000 }, /tenant denied/);
        const parent = await grant(f);
        await reject('grant', { token: f.A.sessions.manager, target: f.A.actors.restricted, parent, capability: 'marketing.send', scope: bindingScope(f.A), mode: 'propose', delegate: false, expires: Date.now() + 10000 }, /manage scope/);
        await manage(f);
        await reject('grant', { token: f.A.sessions.manager, target: f.A.actors.child, parent, capability: 'marketing.send', scope: bindingScope(f.A, { currency: 'EUR' }), mode: 'propose', delegate: false, expires: Date.now() + 10000 }, /delegation escalation/);
        const id = await op(f, 'currency', 'manager', 'marketing.send', 1, { payload: { ...payload(), currency: 'EUR' } });
        await approve(f, id);
        await reject('claim', { token: f.A.sessions.manager, id, worker: 'w' }, /authority denied/);
        await assert.rejects(op(f, 'fraction', 'manager', 'marketing.send', 1, { payload: { ...payload(), amountMinor: 1.5 } }), /invalid integer exposure/);
    });
    await test('Explicit manage lists cannot authorize firing or regranting an ancestor', async () => {
        const f = seed();
        await manage(f);
        const parent = await grant(f);
        const childGrant = await call('grant', { token: f.A.sessions.manager, target: f.A.actors.child, parent, capability: 'marketing.send', scope: bindingScope(f.A), mode: 'propose', delegate: true, expires: Date.now() + 30000 });
        await manage(f, 'child', ['manager']);
        await reject('revoke', { token: f.A.sessions.child, target: f.A.actors.manager }, /ancestor manage denied/);
        await reject('grant', { token: f.A.sessions.child, target: f.A.actors.manager, parent: childGrant, capability: 'marketing.send', scope: bindingScope(f.A), mode: 'propose', delegate: false, expires: Date.now() + 10000 }, /ancestor manage denied/);
    });
    await test('Direct mode executes without human approval; propose mode and invalidated direct grant refuse', async () => {
        const f = seed();
        const proposeGrant = await grant(f);
        const proposed = await op(f, 'needs-approval');
        await reject('claim', { token: f.A.sessions.manager, id: proposed, worker: 'w' }, /human approval required/);
        await call('revokeGrant', { token: f.A.sessions.owner, id: proposeGrant });
        const direct = await grant(f, 'manager', 'marketing.send', { mode: 'direct' });
        const id = await op(f, 'direct');
        const c = await claim(f, id);
        assert.ok((await get(f, id)).approval.approver.grant);
        await call('revokeGrant', { token: f.A.sessions.owner, id: direct });
        await reject('permit', { token: f.A.adapter, id, ...c, worker: 'worker-1' }, /stale claim/);
        const newId = await op(f, 'direct-removed');
        await approve(f, newId);
        await reject('claim', { token: f.A.sessions.manager, id: newId, worker: 'w' }, /authority denied/);
        await grant(f, 'manager', 'billing.refund', { mode: 'direct' });
        const independent = await op(f, 'independent', 'manager', 'billing.refund');
        assert.equal((await claim(f, independent)).step, 1);
    });
    await test('Delegation ancestry revokes queued/read/model paths while independent human grant survives', async () => {
        const f = seed();
        await manage(f);
        const root = await grant(f), model = await grant(f, 'manager', 'model.call');
        const delegate = (parent, capability, scope) => call('grant', { token: f.A.sessions.manager, target: f.A.actors.child, parent, capability, scope, mode: 'propose', delegate: true, expires: Date.now() + 30000 });
        await delegate(root, 'marketing.send', bindingScope(f.A));
        await delegate(model, 'model.call', modelScope);
        await reject('revoke', { token: f.A.sessions.child, target: f.A.actors.manager }, /manage scope|ancestor manage denied/);
        const queued = await op(f, 'queued', 'child');
        await approve(f, queued);
        const c = await claim(f, queued, 'child');
        const next = await op(f, 'next-model', 'child', 'model.call');
        await approve(f, next);
        await grant(f, 'child', 'billing.refund');
        const independent = await op(f, 'independent', 'child', 'billing.refund');
        await approve(f, independent);
        await fire(f);
        await reject('permit', { token: f.A.adapter, id: queued, ...c, worker: 'worker-1' }, /stale claim/);
        await reject('claim', { token: f.A.sessions.child, id: next, worker: 'w' }, /not claimable/);
        assert.equal((await claim(f, independent, 'child')).step, 1);
    });
    await test('Read scopes restrict object/records/fields and every SIM surface has a leakable shape', async () => {
        const f = seed();
        assert.deepEqual(await read('read', { token: f.A.sessions.child, surface: 'record' }), []);
        await manage(f);
        await grant(f, 'restricted', 'read', { scope: { kind: 'records', object: 'person', records: 'all', fields: ['public'] } });
        assert.deepEqual(await read('read', { token: f.A.sessions.restricted, surface: 'export' }), [{ public: 'visible A' }]);
        const parent = await grant(f, 'manager', 'read', { scope: { kind: 'records', object: 'person', records: [f.A.record], fields: ['public'] } });
        await reject('grant', { token: f.A.sessions.manager, target: f.A.actors.child, parent, capability: 'read', scope: { kind: 'records', object: 'person', records: 'all', fields: ['public', 'secret'] }, mode: 'propose', delegate: false, expires: Date.now() + 10000 }, /delegation escalation/);
        await call('grant', { token: f.A.sessions.manager, target: f.A.actors.child, parent, capability: 'read', scope: { kind: 'records', object: 'person', records: [f.A.record], fields: ['public'] }, mode: 'propose', delegate: false, expires: Date.now() + 10000 });
        for (const surface of ['record', 'history', 'suggestion', 'export', 'report', 'MCP', 'REST', 'search', 'file', 'provider', 'subscription']) {
            const rows = await read('read', { token: f.A.sessions.child, surface });
            assert.equal(rows.length, 1);
            assert.ok(JSON.stringify(rows).includes('visible A'));
            assert.ok(!JSON.stringify(rows).includes('SECRET'));
            assert.ok(!JSON.stringify(rows).includes('invoice'));
            for (const property of ['filterField', 'sortField', 'groupField'])
                await assert.rejects(read('read', { token: f.A.sessions.child, surface, [property]: 'secret' }), /masked inference/);
        }
        const id = await op(f, 'hidden', 'manager', 'marketing.send', 1, { payload: { ...payload(), content: 'SECRET-derived suggestion' } });
        const status = await read('operation', { token: f.A.sessions.manager, id });
        assert.equal(status.payload, undefined, 'agent status must not bypass masked suggestion reads');
        assert.ok(!JSON.stringify(status).includes('SECRET'));
        await assert.rejects(read('operation', { token: f.A.sessions.child, id }), /operation scope denied/);
        await assert.rejects(read('read', { token: f.A.sessions.child, surface: 'record', record: f.B.record }), /tenant denied/);
        await fire(f);
        assert.deepEqual(await read('read', { token: f.A.sessions.child, surface: 'record' }), []);
    });
    await test('Final permit rechecks expired authority without a sweep and honors schedule', async () => {
        const f = seed();
        await grant(f, 'manager', 'marketing.send', { expires: Date.now() + 1500 });
        const id = await op(f, 'expiry');
        await approve(f, id);
        const c = await claim(f, id);
        await wait(1600);
        await reject('permit', { token: f.A.adapter, id, ...c, worker: 'worker-1' }, /authority denied/);
        const g = seed();
        await grant(g);
        const scheduled = await op(g, 'future', 'manager', 'marketing.send', 1, { payload: { ...payload(), schedule: Date.now() + 60000 } });
        await approve(g, scheduled);
        const d = await claim(g, scheduled);
        await reject('permit', { token: g.A.adapter, id: scheduled, ...d, worker: 'worker-1' }, /schedule not due/);
    });
    await test('Before-permit fire refuses; after-permit fire preserves one late outcome', async () => {
        const f = seed();
        await grant(f);
        const id = await op(f, 'before');
        await approve(f, id);
        const c = await claim(f, id);
        await fire(f);
        await reject('permit', { token: f.A.adapter, id, ...c, worker: 'worker-1' }, /stale claim/);
        const g = seed();
        await grant(g);
        const later = await op(g, 'after');
        await approve(g, later);
        const d = await claim(g, later), p = await permit(g, later, d);
        await fire(g);
        assert.equal((await get(g, later)).state, 'cancellationPending');
        const receipt = accept(await consume(g, p));
        const { expires, maxUnits, maxRecipients, ...spent } = p;
        await reject('consume', { token: g.A.adapter, ...spent }, /invalid or spent/);
        await finish(g, later, d, receipt);
        assert.equal((await get(g, later)).late, true);
        assert.equal(receipt.calls, 1);
    });
    await test('Scoped adapter cannot permit, consume, reconcile, callback or provision in B', async () => {
        const f = seed();
        const id = await call('propose', { token: f.B.sessions.owner, logical: 'B', binding: f.B.binding, capability: 'marketing.send', payload: payload('B'), reservationUnits: 1, maxSteps: 1 });
        await call('approve', { token: f.B.sessions.owner, id, expires: Date.now() + 60000 });
        const c = await call('claim', { token: f.B.sessions.owner, id, worker: 'b' });
        await reject('permit', { token: f.A.adapter, id, ...c, worker: 'b' }, /adapter scope/);
        const p = await call('permit', { token: f.B.adapter, id, ...c, worker: 'b' });
        const { expires, maxUnits, maxRecipients, ...pArgs } = p;
        await reject('consume', { token: f.A.adapter, ...pArgs }, /adapter scope/);
        await call('consume', { token: f.B.adapter, ...pArgs });
        await reject('reconcile', { token: f.A.adapter, id, ...c, providerRef: 'forged', usage: 1 }, /adapter scope/);
        await reject('callback', { token: f.A.adapter, binding: f.B.binding, eventId: 'fake', body: '{"version":1,"state":"suppressed"}' }, /adapter scope/);
        await reject('provision', { token: f.A.adapter, binding: f.B.binding, intent: 'forged', remove: false }, /adapter scope/);
        await assert.rejects(read('dump', {}), /public function|internal|Could not find/);
    });
    await test('Lost acceptance response reconciles once; missing usage blocks cheaper new spend', async () => {
        const f = seed();
        await grant(f);
        const id = await op(f, 'loss', 'manager', 'marketing.send', 6);
        await approve(f, id);
        const c = await claim(f, id), p = await permit(f, id, c), receipt = accept(await consume(f, p));
        await call('unknown', { token: f.A.adapter, id, ...c });
        await reject('claim', { token: f.A.sessions.manager, id, worker: 'retry' }, /not claimable/);
        await call('reconcile', { token: f.A.adapter, id, ...c, providerRef: receipt.ref });
        assert.equal(dump(f).orgs.find(o => o._id === f.A.org).reserved, 6);
        const cheap = await op(f, 'cheap');
        await approve(f, cheap);
        await reject('claim', { token: f.A.sessions.manager, id: cheap, worker: 'w' }, /usage unresolved/);
        await finish(f, id, c, receipt, 2);
        await finish(f, id, c, receipt, 2);
        assert.equal(dump(f).orgs.find(o => o._id === f.A.org).spent, 2);
        await claim(f, cheap);
        assert.equal(receipt.calls, 1);
    });
    await test('Concurrent logical calls/claims and org budget reservations serialize on real backend', async () => {
        const f = seed();
        await grant(f);
        const same = await Promise.all([op(f, 'same'), op(f, 'same')]);
        assert.equal(same[0], same[1]);
        await approve(f, same[0]);
        const claims = await Promise.allSettled([claim(f, same[0]), claim(f, same[0], 'manager', 'worker2')]);
        assert.equal(claims.filter(x => x.status === 'fulfilled').length, 1);
        const g = seed();
        await grant(g);
        const ids = await Promise.all([op(g, 'cap1', 'manager', 'marketing.send', 6), op(g, 'cap2', 'manager', 'marketing.send', 6)]);
        await Promise.all(ids.map(id => approve(g, id)));
        const reservations = await Promise.allSettled(ids.map(id => claim(g, id)));
        assert.equal(reservations.filter(x => x.status === 'fulfilled').length, 1);
        assert.match(String(reservations.find(x => x.status === 'rejected').reason), /budget cap/);
        assert.equal(dump(g).orgs.find(o => o._id === g.A.org).reserved, 6);
    });
    await test('Per-run/global spend and global concurrency caps bound both tenants', async () => {
        const f = seed();
        await grant(f, 'manager', 'model.call', { scope: { ...modelScope, maxUnitsPerRun: 20 } });
        const big = await op(f, 'big', 'manager', 'model.call', 9);
        await approve(f, big);
        await reject('claim', { token: f.A.sessions.manager, id: big, worker: 'w' }, /per-run cap/);
        async function both(f, units, count) {
            const ids = [];
            for (const tenant of ['A', 'B']) {
                const t = f[tenant];
                for (let i = 0; i < count; i++) {
                    const id = await call('propose', { token: t.sessions.owner, logical: tenant + i, binding: t.binding, capability: 'marketing.send', payload: payload(tenant), reservationUnits: units, maxSteps: 1 });
                    await call('approve', { token: t.sessions.owner, id, expires: Date.now() + 60000 });
                    ids.push({ token: t.sessions.owner, id, worker: tenant + i });
                }
            }
            return Promise.allSettled(ids.map(args => call('claim', args)));
        }
        const spend = await both(seed(), 8, 1);
        assert.equal(spend.filter(x => x.status === 'fulfilled').length, 1);
        assert.match(String(spend.find(x => x.status === 'rejected').reason), /global budget\/concurrency cap/);
        const concurrency = await both(seed(), 1, 2);
        assert.equal(concurrency.filter(x => x.status === 'fulfilled').length, 3);
    });
    await test('Model continuation rechecks authority, step/fence and remaining exposure', async () => {
        const f = seed();
        await manage(f);
        const root = await grant(f, 'manager', 'model.call');
        await call('grant', { token: f.A.sessions.manager, target: f.A.actors.child, parent: root, capability: 'model.call', scope: modelScope, mode: 'propose', delegate: false, expires: Date.now() + 30000 });
        const id = await op(f, 'model', 'child', 'model.call', 4);
        await approve(f, id);
        const c = await claim(f, id, 'child'), p = await permit(f, id, c), request = await consume(f, p), receipt = accept(request);
        assert.match(request.key, /:step:1$/);
        await finish(f, id, c, receipt, 1, true);
        await finish(f, id, c, receipt, 1);
        assert.equal((await get(f, id)).receipts.length, 1);
        const next = await claim(f, id, 'child');
        assert.equal(next.step, 2);
        await fire(f);
        await reject('permit', { token: f.A.adapter, id, ...next, worker: 'worker-1' }, /stale claim/);
        assert.equal(dump(f).orgs.find(o => o._id === f.A.org).spent, 1);
    });
    await test('Expired unconsumed permits retry safely; consumed crash becomes unknown', async () => {
        const f = seed();
        await grant(f);
        const id = await op(f, 'crash-before');
        await approve(f, id);
        const c = await claim(f, id), p = await permit(f, id, c);
        await wait(1100);
        await call('expire', { token: f.A.adapter, id });
        assert.equal((await get(f, id)).state, 'queued');
        const retry = await claim(f, id);
        assert.ok(retry.fence > c.fence);
        const { expires, maxUnits, maxRecipients, ...old } = p;
        await reject('consume', { token: f.A.adapter, ...old }, /invalid or spent/);
        const fresh = await permit(f, id, retry);
        await consume(f, fresh);
        await wait(2100);
        await call('expire', { token: f.A.adapter, id });
        assert.equal((await get(f, id)).state, 'outcomeUnknown');
        await reject('claim', { token: f.A.sessions.manager, id, worker: 'retry' }, /not claimable/);
    });
    await test('Unknown authoritative absence never resends after firing; terminal rejection releases reservation', async () => {
        const f = seed();
        await grant(f);
        const id = await op(f, 'absent');
        await approve(f, id);
        const c = await claim(f, id), p = await permit(f, id, c);
        const request = await consume(f, p);
        await call('unknown', { token: f.A.adapter, id, ...c });
        await fire(f);
        await call('resolveUnknown', { token: f.A.adapter, id, ...c, absent: true, finality: 'provisional' });
        assert.equal((await get(f, id)).state, 'outcomeUnknown');
        await call('resolveUnknown', { token: f.A.adapter, id, ...c, absent: true, finality: 'final' });
        assert.equal((await get(f, id)).state, 'refused');
        assert.equal(provider.has(JSON.stringify([request.providerKey, request.key])), false);
        assert.equal(dump(f).orgs.find(o => o._id === f.A.org).reserved, 0);
        const g = seed();
        await grant(g);
        const failed = await op(g, 'terminal');
        await approve(g, failed);
        const d = await claim(g, failed);
        await permit(g, failed, d);
        await call('fail', { token: g.A.adapter, id: failed, ...d, retryable: false });
        assert.equal((await get(g, failed)).state, 'refused');
        assert.equal(dump(g).orgs.find(o => o._id === g.A.org).reserved, 0);
        await reject('claim', { token: g.A.sessions.manager, id: failed, worker: 'again' }, /released|not claimable/);
    });
    await test('Authoritative absence and retryable rejection preserve logical key and revalidate new permits', async () => {
        const f = seed();
        await grant(f);
        const id = await op(f, 'safe-retry');
        await approve(f, id);
        const c = await claim(f, id), p = await permit(f, id, c);
        await consume(f, p);
        await call('unknown', { token: f.A.adapter, id, ...c });
        await call('resolveUnknown', { token: f.A.adapter, id, ...c, absent: true, finality: 'provisional' });
        const d = await claim(f, id), p2 = await permit(f, id, d), receipt = accept(await consume(f, p2));
        await finish(f, id, d, receipt);
        assert.equal(receipt.calls, 1);
        const g = seed();
        await grant(g);
        const rejected = await op(g, 'retryable');
        await approve(g, rejected);
        const q = await claim(g, rejected);
        await permit(g, rejected, q);
        await call('fail', { token: g.A.adapter, id: rejected, ...q, retryable: true });
        const retry = await claim(g, rejected);
        assert.ok(retry.fence > q.fence);
        await fire(g);
        await reject('permit', { token: g.A.adapter, id: rejected, ...retry, worker: 'worker-1' }, /stale claim/);
    });
    await test('Material edits, audience, currency and approval expiry invalidate immutable snapshot', async () => {
        const f = seed();
        await grant(f);
        const id = await op(f, 'edit');
        await approve(f, id);
        await call('edit', { token: f.A.sessions.manager, id, payload: { ...payload(), content: 'changed', audienceVersion: 2 } });
        await reject('claim', { token: f.A.sessions.manager, id, worker: 'w' }, /human approval required/);
        await call('approve', { token: f.A.sessions.owner, id, expires: Date.now() - 1 });
        await reject('claim', { token: f.A.sessions.manager, id, worker: 'w' }, /approval changed\/expired/);
    });
    await test('Authenticated fake callback body dedup/out-of-order suppression reaches final permit in readonly', async () => {
        const f = seed();
        await grant(f);
        const id = await op(f, 'suppressed');
        await approve(f, id);
        const c = await claim(f, id), message = signed(f.A, 'event1', JSON.stringify({ version: 2, state: 'suppressed' }));
        await assert.rejects(inbound(f.A, { ...message, body: JSON.stringify({ version: 2, state: 'subscribed' }) }), /invalid fake callback signature/);
        await reject('callback', { token: f.A.sessions.manager, binding: f.A.binding, eventId: 'fake', body: message.body }, /adapter only/);
        const r = await Promise.all([inbound(f.A, message), inbound(f.A, message)]);
        assert.deepEqual(r.sort(), ['applied', 'duplicate']);
        await reject('callback', { token: f.A.adapter, binding: f.A.binding, eventId: 'event1', body: '{"version":99,"state":"subscribed"}' }, /callback integrity/);
        await inbound(f.A, signed(f.A, 'old', JSON.stringify({ version: 1, state: 'subscribed' })));
        assert.equal(dump(f).observations.find(o => o.binding === f.A.binding).version, 2);
        await reject('permit', { token: f.A.adapter, id, ...c, worker: 'worker-1' }, /consent denied/);
        await call('control', { token: f.A.sessions.owner, readonly: true });
        await inbound(f.A, signed(f.A, 'new', JSON.stringify({ version: 3, state: 'subscribed' })));
        assert.equal(dump(f).consent.find(x => x.org === f.A.org).suppressed, true);
        await call('cancel', { token: f.A.sessions.owner, id });
        assert.equal((await get(f, id)).state, 'cancelled');
        await assert.rejects(op(f, 'readonly'), /readonly/);
    });
    await test('Readonly allows truthful late reconciliation, masked export and human adoption preserves authorship', async () => {
        const f = seed();
        await grant(f);
        const id = await op(f, 'inflight');
        await approve(f, id);
        const c = await claim(f, id), p = await permit(f, id, c), receipt = accept(await consume(f, p));
        await call('control', { token: f.A.sessions.owner, readonly: true });
        await call('cancel', { token: f.A.sessions.owner, id });
        await finish(f, id, c, receipt);
        assert.equal((await get(f, id)).state, 'confirmed');
        assert.equal((await read('read', { token: f.A.sessions.owner, surface: 'export' })).length, 2);
        const g = seed();
        const suggestion = await op(g, 'suggestion');
        await fire(g);
        await reject('approve', { token: g.A.sessions.owner, id: suggestion, expires: Date.now() + 10000 }, /approval denied|stale actor/);
        const adopted = await op(g, 'adopted', 'owner', 'marketing.send', 1, { adoptedFrom: suggestion });
        await approve(g, adopted);
        const result = await get(g, adopted);
        assert.equal(result.author, g.A.actors.manager);
        assert.equal(result.owner, g.A.actors.owner);
        assert.equal(result.actor, g.A.actors.owner);
        assert.equal(result.adoptedFrom, suggestion);
        assert.equal((await claim(g, adopted, 'owner')).step, 1);
    });
    await test('Provisioning durable intents preserve delete-before/create-before races', async () => {
        const f = seed();
        for (const order of ['create-first', 'delete-first']) {
            const base = { binding: f.A.binding, intent: order };
            await call('provision', { ...base, token: f.A.sessions.owner, remove: false });
            const create = () => call('provision', { ...base, token: f.A.adapter, remove: false, externalId: 'external-' + order });
            const remove = () => call('provision', { ...base, token: f.A.sessions.owner, remove: true });
            if (order === 'create-first') {
                await create();
                await remove();
            }
            else {
                await remove();
                await create();
            }
            await create();
        }
        assert.ok(dump(f).provisions.every(p => p.deleted && p.cleanup));
        await reject('provision', { token: f.A.adapter, binding: f.A.binding, intent: 'missing', remove: false, externalId: 'orphan' }, /intent required/);
    });
    await test('Partial traversal commits only full checkpoints and later traversal resumes without regression', async () => {
        const f = seed(), base = { token: f.A.adapter, binding: f.A.binding, traversal: 'run1', from: 0, checkpoint: 99 };
        assert.equal(await call('page', { ...base, page: 1, items: ['1', '2'], end: false }), 0);
        assert.equal(await call('page', { ...base, page: 1, items: ['1', '2'], end: false }), 0);
        await reject('page', { ...base, page: 3, items: ['4'], end: true }, /gap/);
        assert.equal(await call('page', { ...base, page: 2, items: ['2', '3'], end: true }), 99);
        await reject('page', { ...base, traversal: 'run2', from: 0, page: 1, items: ['4'], end: true, checkpoint: 100 }, /checkpoint mismatch/);
        assert.equal(await call('page', { ...base, traversal: 'run2', from: 99, page: 1, items: ['4'], end: false, checkpoint: 100 }), 99);
        assert.equal(await call('page', { ...base, traversal: 'run2', from: 99, page: 2, items: ['5'], end: true, checkpoint: 100 }), 100);
        await reject('page', { ...base, traversal: 'run3', from: 100, page: 1, items: [], end: true, checkpoint: 98 }, /regression/);
        assert.deepEqual(dump(f).cursors[0].items, ['1', '2', '3', '4', '5']);
    });
    await test('Durable cancellation survives rejection, absence, expiry and model continuation', async () => {
        for (const path of ['rejection', 'absence', 'expiry', 'continue']) {
            const f = seed(), cap = path === 'continue' ? 'model.call' : 'marketing.send';
            await grant(f, 'manager', cap);
            const id = await op(f, path, 'manager', cap, 3);
            await approve(f, id);
            const c = await claim(f, id), p = await permit(f, id, c), request = path === 'expiry' ? null : await consume(f, p);
            await call('cancel', { token: f.A.sessions.owner, id });
            await call('cancel', { token: f.A.sessions.owner, id });
            if (path === 'rejection') {
                await call('fail', { token: f.A.adapter, id, ...c, retryable: true });
                await call('fail', { token: f.A.adapter, id, ...c, retryable: true });
                assert.equal((await get(f, id)).state, 'outcomeUnknown');
                assert.equal(dump(f).orgs.find(o => o._id === f.A.org).reserved, 3);
                await call('resolveUnknown', { token: f.A.adapter, id, ...c, absent: true, finality: 'final' });
                await call('resolveUnknown', { token: f.A.adapter, id, ...c, absent: true, finality: 'final' });
            }
            if (path === 'absence') {
                await call('unknown', { token: f.A.adapter, id, ...c });
                await call('resolveUnknown', { token: f.A.adapter, id, ...c, absent: true, finality: 'provisional' });
                assert.equal((await get(f, id)).state, 'outcomeUnknown');
                assert.equal(dump(f).orgs.find(o => o._id === f.A.org).reserved, 3);
                await call('resolveUnknown', { token: f.A.adapter, id, ...c, absent: true, finality: 'final' });
            }
            if (path === 'expiry')
                await wait(1250);
            if (path === 'continue')
                await finish(f, id, c, accept(request), 1, true);
            assert.equal((await get(f, id)).state, 'cancelled');
            await assert.rejects(claim(f, id), /cancellation requested/);
            await reject('permit', { token: f.A.adapter, id, ...c, worker: 'worker-1' }, /stale claim|cancellation requested/);
            const org = dump(f).orgs.find(o => o._id === f.A.org);
            assert.equal(org.active, 0);
            assert.equal(org.reserved, 0);
            assert.equal(org.spent, path === 'continue' ? 1 : 0);
        }
    });
    await test('Scoped adapter sees cancellation signal and records one late accepted tail', async () => {
        for (const action of ['cancel', 'fire']) {
            const f = seed();
            await grant(f);
            const id = await op(f, 'signal-' + action);
            await approve(f, id);
            const c = await claim(f, id), p = await permit(f, id, c);
            assert.equal((await read('adapterStatus', { token: f.A.adapter, id, ...c })).cancel, false);
            if (action === 'cancel')
                await call('cancel', { token: f.A.sessions.owner, id });
            else
                await fire(f);
            assert.equal((await read('adapterStatus', { token: f.A.adapter, id, ...c })).cancel, true);
            await assert.rejects(read('adapterStatus', { token: f.B.adapter, id, ...c }), /adapter scope/);
            const receipt = accept(await consume(f, p));
            await finish(f, id, c, receipt);
            await finish(f, id, c, receipt);
            assert.equal((await get(f, id)).state, 'confirmed');
            assert.equal((await get(f, id)).late, true);
            assert.equal(dump(f).orgs.find(o => o._id === f.A.org).spent, 1);
            assert.equal(receipt.calls, 1);
            assert.ok(dump(f).events.some(e => e.resource === id && e.kind === (action === 'cancel' ? 'completedAfterCancellation' : 'completedAfterRevocation')));
        }
    });
    await test('Late consumed outcome settles once after provisional or final absent lookup', async () => {
        for (const finality of ['provisional', 'final']) {
            const f = seed();
            await grant(f);
            const id = await op(f, 'late-' + finality);
            await approve(f, id);
            const c = await claim(f, id), request = await consume(f, await permit(f, id, c));
            await call('unknown', { token: f.A.adapter, id, ...c });
            await fire(f);
            await call('resolveUnknown', { token: f.A.adapter, id, ...c, absent: true, finality });
            const before = dump(f).orgs.find(o => o._id === f.A.org);
            assert.equal(before.reserved, finality === 'provisional' ? 1 : 0);
            assert.equal(before.active, finality === 'provisional' ? 1 : 0);
            const receipt = accept(request);
            await finish(f, id, c, receipt);
            await finish(f, id, c, receipt);
            const opResult = await get(f, id), org = dump(f).orgs.find(o => o._id === f.A.org);
            assert.equal(opResult.state, 'confirmed');
            assert.equal(opResult.late, true);
            assert.equal(org.reserved, 0);
            assert.equal(org.active, 0);
            assert.equal(org.spent, 1);
            assert.equal(receipt.calls, 1);
            if (finality === 'final') {
                assert.equal(org.anomaly, 'acceptedAfterFinalAbsence');
                const next = await op(f, 'held', 'owner');
                await approve(f, next);
                await reject('claim', { token: f.A.sessions.owner, id: next, worker: 'w' }, /anomaly hold/);
            }
        }
    });
    await test('Per-call remaining exposure, missing usage and actual overruns fence final dispatch', async () => {
        const f = seed();
        await grant(f, 'manager', 'model.call');
        const id = await op(f, 'exhaust', 'manager', 'model.call', 2);
        await approve(f, id);
        const c = await claim(f, id), p = await permit(f, id, c);
        assert.equal(p.maxUnits, 2);
        assert.equal(p.maxRecipients, 1);
        const request = await consume(f, p);
        assert.equal(request.maxUnits, 2);
        const exhausted = await finish(f, id, c, accept(request), 2, true);
        assert.equal(exhausted.continuationRefused, true);
        assert.equal((await get(f, id)).state, 'confirmed');
        assert.equal(dump(f).orgs.find(o => o._id === f.A.org).active, 0);
        const g = seed();
        await grant(g);
        const ids = await Promise.all(['missing', 'queued'].map(n => op(g, n)));
        await Promise.all(ids.map(id => approve(g, id)));
        const cs = await Promise.all(ids.map(id => claim(g, id)));
        const receipt = accept(await consume(g, await permit(g, ids[0], cs[0])));
        await call('reconcile', { token: g.A.adapter, id: ids[0], ...cs[0], providerRef: receipt.ref });
        await reject('permit', { token: g.A.adapter, id: ids[1], ...cs[1], worker: 'worker-1' }, /usage unresolved/);
        const h = seed();
        await grant(h, 'manager', 'model.call');
        const over = await op(h, 'over', 'manager', 'model.call', 4);
        await approve(h, over);
        const a = await claim(h, over);
        await finish(h, over, a, accept(await consume(h, await permit(h, over, a))), 2, true);
        assert.equal(dump(h).orgs.find(o => o._id === h.A.org).reserved, 2);
        const b = await claim(h, over), p2 = await permit(h, over, b);
        assert.equal(p2.maxUnits, 2);
        const r = accept(await consume(h, p2));
        await finish(h, over, b, r, 3, true);
        await finish(h, over, b, r, 3, true);
        const result = await get(h, over), org = dump(h).orgs.find(o => o._id === h.A.org);
        assert.equal(result.overrun, true);
        assert.equal(result.state, 'paused');
        assert.equal(org.spent, 5);
        assert.equal(org.reserved, 0);
        assert.equal(org.active, 0);
        assert.equal(org.anomaly, 'usageOverrun');
        await assert.rejects(claim(h, over), /cancellation requested/);
        const e = seed();
        await grant(e, 'manager', 'model.call');
        const completed = await op(e, 'completed', 'manager', 'model.call', 3);
        await approve(e, completed);
        const ec = await claim(e, completed), er = accept(await consume(e, await permit(e, completed, ec)));
        await call('reconcile', { token: e.A.adapter, id: completed, ...ec, providerRef: er.ref });
        const noRestart = await finish(e, completed, ec, er, 1, true);
        assert.equal(noRestart.continuationRefused, true);
        assert.equal((await get(e, completed)).state, 'confirmed');
        assert.equal((await get(e, completed)).step, 1);
        const fresh = await op(h, 'after-overrun', 'owner');
        await approve(h, fresh);
        await reject('claim', { token: h.A.sessions.owner, id: fresh, worker: 'w' }, /anomaly hold/);
        await call('control', { token: h.A.sessions.owner, clearAnomaly: true });
        await claim(h, fresh, 'owner');
    });
    await test('Conflicting provider reference refuses durably and holds spend without rolling back anomaly', async () => {
        const f = seed();
        await grant(f);
        const id = await op(f, 'collision');
        await approve(f, id);
        const c = await claim(f, id), receipt = accept(await consume(f, await permit(f, id, c)));
        await finish(f, id, c, receipt);
        const rejected = await call('reconcile', { token: f.A.adapter, id, ...c, providerRef: 'different-accepted-id', usage: 1 });
        assert.deepEqual(rejected, { accepted: false, error: 'provider result collision' });
        const data = dump(f), org = data.orgs.find(o => o._id === f.A.org);
        assert.equal(org.spent, 1);
        assert.equal(org.anomaly, 'provider result collision');
        assert.equal((await get(f, id)).receipts.length, 1);
    });
    await test('Per-recipient and per-purpose suppression never changes another contact or tenant', async () => {
        const f = seed();
        await grant(f, 'manager', 'marketing.send', { scope: bindingScope(f.A, { bindings: [f.A.binding, f.A.bindingY] }) });
        const x = await op(f, 'X'), y = await op(f, 'Y', 'manager', 'marketing.send', 1, { binding: f.A.bindingY, payload: { ...payload(), audience: ['recipient-Y'] } });
        await approve(f, x);
        await approve(f, y);
        const cx = await claim(f, x), cy = await claim(f, y);
        await inbound(f.A, signed(f.A, 'X-unsubscribe', JSON.stringify({ version: 1, state: 'suppressed', channel: 'email', purpose: 'marketing' })));
        await reject('permit', { token: f.A.adapter, id: x, ...cx, worker: 'worker-1' }, /consent denied/);
        const py = await permit(f, y, cy);
        await finish(f, y, cy, accept(await consume(f, py)));
        const before = dump(f).consent.filter(c => c.org === f.A.org);
        await inbound(f.B, signed(f.B, 'same-id', JSON.stringify({ version: 1, state: 'suppressed', channel: 'email', purpose: 'marketing' })));
        assert.deepEqual(dump(f).consent.filter(c => c.org === f.A.org), before);
        assert.equal(before.find(c => c.recipient === 'recipient-Y').suppressed, false);
        await call('control', { token: f.A.sessions.owner, suppress: false, recipient: 'recipient' });
        await inbound(f.A, signed(f.A, 'transactional', JSON.stringify({ version: 2, state: 'suppressed', channel: 'email', purpose: 'transactional' })));
        assert.equal(dump(f).consent.find(c => c.org === f.A.org && c.recipient === 'recipient').suppressed, false);
    });
    await test('Server scheduler recovers adapter crashes without a callback or manual expiry call', async () => {
        const f = seed();
        await grant(f);
        const first = await op(f, 'crashed'), second = await op(f, 'next');
        await approve(f, first);
        await approve(f, second);
        const c = await claim(f, first);
        await consume(f, await permit(f, first, c));
        await wait(2400);
        assert.equal((await get(f, first)).state, 'outcomeUnknown');
        const next = await claim(f, second);
        assert.ok(await permit(f, second, next));
    });
    await test('Manager grant downgrade invalidates delegated queued/model/read work, independent human scope survives', async () => {
        const f = seed();
        await manage(f);
        const parent = await grant(f), model = await grant(f, 'manager', 'model.call'), reads = await grant(f, 'manager', 'read', { scope: { kind: 'records', object: 'person', records: 'all', fields: ['public'] } });
        for (const [root, capability, scope] of [[parent, 'marketing.send', bindingScope(f.A)], [model, 'model.call', modelScope], [reads, 'read', { kind: 'records', object: 'person', records: 'all', fields: ['public'] }]])
            await call('grant', { token: f.A.sessions.manager, target: f.A.actors.child, parent: root, capability, scope, mode: 'propose', delegate: false, expires: Date.now() + 30000 });
        const queued = await op(f, 'queued', 'child'), modelNext = await op(f, 'model-next', 'child', 'model.call');
        await approve(f, queued);
        await approve(f, modelNext);
        const c = await claim(f, queued, 'child');
        await grant(f, 'child', 'billing.refund');
        const independent = await op(f, 'independent', 'child', 'billing.refund');
        await approve(f, independent);
        assert.equal((await read('read', { token: f.A.sessions.child, surface: 'export' })).length, 1);
        await call('revokeGrant', { token: f.A.sessions.owner, id: parent });
        await reject('permit', { token: f.A.adapter, id: queued, ...c, worker: 'worker-1' }, /stale claim|authority/);
        await reject('claim', { token: f.A.sessions.child, id: modelNext, worker: 'w' }, /not claimable|authority/);
        assert.deepEqual(await read('read', { token: f.A.sessions.child, surface: 'export' }), []);
        assert.ok(await claim(f, independent, 'child'));
    });
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
    const exports = fixtures.map(dump), serialized = JSON.stringify(exports, null, 2);
    writeFileSync('evidence/fixture-export.json', serialized);
    const fixtureSha256 = createHash('sha256').update(serialized).digest('hex');
    const sourceHashes = Object.fromEntries(['convex/contract.ts', 'convex/schema.ts', 'convex/harness.ts', 'replay.mjs', 'run.mjs', 'package.json'].map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
    writeFileSync('evidence/results.json', JSON.stringify({ level: 'SERVICE local Convex / SIM provider and identity', backend: url, at: new Date().toISOString(), results, fixtureSha256, sourceHashes, providerEffects: provider.size }, null, 2));
    console.log(`H0 SERVICE replay: ${results.length} behavioral groups PASS; fixture SHA256 ${fixtureSha256}`);
}
try {
    await main();
    writeFileSync('evidence/.run-result.json', JSON.stringify({ code: 0 }));
}
catch (error) {
    console.error(error);
    writeFileSync('evidence/.run-result.json', JSON.stringify({ code: 1, error: String(error) }));
    process.exitCode = 1;
}
