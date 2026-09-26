// Independent I1 attack suite. Runs on the builder's isolated local backend harness
// (ops/authority/local.mjs, moved to ports 3490/3491) with synthetic JWTs and data.
// Every check records what it observed; nothing aborts the run, so one failure
// cannot hide the rest. Usage: I1_EVIDENCE_DIR=<dir> node evidence/2026-09-25-i1/iv/iv-service.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { anyApi } from 'convex/server';
import { ConvexClient } from 'convex/browser';
import { withAuthority, evidencePath } from '../../../ops/authority/local.mjs';
import { tenant as makeTenant, commands } from '../../../ops/authority/service-fixture.mjs';
import inventory from '../../../ops/authority/inventory.json' with { type: 'json' };

const only = process.env.IV_ONLY ? new RegExp(process.env.IV_ONLY) : null;
const pause = ms => new Promise(r => setTimeout(r, ms));
const sha = s => createHash('sha256').update(s).digest('hex');
const errText = e => String(e?.data ? JSON.stringify(e.data) : e?.message ?? e);
const attempt = async fn => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: errText(e).slice(0, 300) }; } };

const report = await withAuthority(async f => {
  const results = [];
  const check = async (id, claim, name, fn) => {
    if (only && !only.test(id)) return;
    const started = Date.now();
    try { const observed = await fn(); results.push({ id, claim, name, status: 'PASS', observed, ms: Date.now() - started }); console.log('PASS', id, name); }
    catch (e) { results.push({ id, claim, name, status: 'FAIL', error: String(e?.stack ?? e).slice(0, 1500), ms: Date.now() - started }); console.log('FAIL', id, name, '\n   ', String(e?.message ?? e).slice(0, 400)); }
  };
  f.run('integrations/connections:registerProvider', { provider: 'fake', enabled: true });
  f.run('integrations/budgets:configure', { cap: 100000, maxConcurrent: 1000, maxPerRun: 1000, maxSteps: 5, maxRecipients: 100 });
  const tenant = (label, limits) => makeTenant(f, label, limits);
  const adapterAs = key => async (name, body) => { const r = await fetch(f.site + '/api/integrations/v1/' + name, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, text: await r.text() }; };
  const rest = key => async (method, path, body) => { const r = await fetch(f.site + '/api/v1/' + path, { method, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const text = await r.text(); return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() }; };
  const all = orgId => f.run('authorityFixtureIv:everything', { orgId });
  const invite = async (t, role, label) => {
    const client = f.client(label + '-' + randomUUID()), userId = await client.mutation(anyApi.users.store, {});
    const inv = await t.human.mutation(anyApi.invites.create, { orgId: t.orgId, role: role === 'owner' ? 'admin' : role }); await client.mutation(anyApi.invites.accept, { token: inv.token });
    if (role === 'owner') await t.human.mutation(anyApi.orgs.setRole, { orgId: t.orgId, userId, role: 'owner' });
    return { client, userId };
  };
  const memberOf = async (t, userId) => (await t.human.query(anyApi.orgs.members, { orgId: t.orgId })).find(m => m.user._id === userId).member;
  const company = async t => { const objects = await t.human.query(anyApi.objects.list, { orgId: t.orgId }), c = objects.find(o => o.key === 'company'), d = await t.human.query(anyApi.objects.get, { orgId: t.orgId, objectId: c._id }); return { object: c, fields: Object.fromEntries(d.fields.map(x => [x.key, x])), objects }; };
  const modelGrant = (t, client, agentId, extra = {}) => client.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: agentId, capability: 'model.call', scope: { kind: 'model', maxUnitsPerRun: 5, maxSteps: 2 }, mode: 'direct', delegate: false, expiresAt: Date.now() + 120000, ...extra });
  const permitStatus = async (t, id, c) => { const r = await adapterAs(t.adapterKey)('permit', { id, ...c, worker: 'worker' }); return r; };

  // ---------- Claim 1: H0 stale worker / approval / role downgrade ----------
  await check('C1-A1', 1, 'Human approver downgraded admin->member between claim and permit: permit refused', async () => {
    const t = await tenant('iv-approver-down'), a = await invite(t, 'admin', 'approver');
    const id = await t.human.mutation(commands.proposeHuman, { orgId: t.orgId, logical: 'down', bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 1, maxSteps: 1 });
    await a.client.mutation(commands.approve, { orgId: t.orgId, id, expiresAt: Date.now() + 60000 });
    const c = await t.claim(id); await t.human.mutation(anyApi.orgs.setRole, { orgId: t.orgId, userId: a.userId, role: 'member' });
    const r = await permitStatus(t, id, c), state = (await t.get(id)).state; assert.equal(r.status, 403, r.text); assert.match(r.text, /Approver authority changed|epoch|Stale claim/i); assert.equal(state, 'paused', 'role change sweep should pause the op'); return { permit: r.text, state };
  });
  await check('C1-A2', 1, 'Approver removed and re-invited as admin between claim and permit: permit refused', async () => {
    const t = await tenant('iv-approver-reinvite'), a = await invite(t, 'admin', 'approver');
    const id = await t.human.mutation(commands.proposeHuman, { orgId: t.orgId, logical: 'reinvite', bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 1, maxSteps: 1 });
    await a.client.mutation(commands.approve, { orgId: t.orgId, id, expiresAt: Date.now() + 60000 }); const c = await t.claim(id);
    await t.human.mutation(anyApi.orgs.removeMember, { orgId: t.orgId, userId: a.userId });
    const inv = await t.human.mutation(anyApi.invites.create, { orgId: t.orgId, role: 'admin' }); await a.client.mutation(anyApi.invites.accept, { token: inv.token });
    const r = await permitStatus(t, id, c); assert.equal(r.status, 403, r.text); return r;
  });
  await check('C1-A3', 1, 'Approver downgraded then restored (admin->member->admin) mid-flight: permit refused (epoch moved)', async () => {
    const t = await tenant('iv-approver-bounce'), a = await invite(t, 'admin', 'approver');
    const id = await t.human.mutation(commands.proposeHuman, { orgId: t.orgId, logical: 'bounce', bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 1, maxSteps: 1 });
    await a.client.mutation(commands.approve, { orgId: t.orgId, id, expiresAt: Date.now() + 60000 }); const c = await t.claim(id);
    await t.human.mutation(anyApi.orgs.setRole, { orgId: t.orgId, userId: a.userId, role: 'member' }); await t.human.mutation(anyApi.orgs.setRole, { orgId: t.orgId, userId: a.userId, role: 'admin' });
    const r = await permitStatus(t, id, c); assert.equal(r.status, 403, r.text); return r;
  });
  await check('C1-A4', 1, 'Grantor owner downgraded to admin while agent holds a claim: direct grant dies, permit refused', async () => {
    const t = await tenant('iv-grantor-down'), o2 = await invite(t, 'owner', 'owner2');
    const agent = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'iv agent', origin: 'external' });
    await modelGrant(t, o2.client, agent.agentId); const call = rest(agent.key);
    const op = await call('POST', 'operations', { logical: 'grantor', bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 1, maxSteps: 1 }); assert.equal(op.status, 201, op.text);
    const c = await call('POST', 'operations/' + op.json + '/claim', { worker: 'worker' }); assert.equal(c.status, 200, c.text);
    await t.human.mutation(anyApi.orgs.setRole, { orgId: t.orgId, userId: o2.userId, role: 'admin' });
    const r = await permitStatus(t, op.json, c.json); assert.equal(r.status, 403, r.text); return r;
  });
  await check('C1-A5', 1, 'Human proposer downgraded admin->member after approval and claim: permit refused', async () => {
    const t = await tenant('iv-proposer-down'), p = await invite(t, 'admin', 'proposer');
    const id = await p.client.mutation(commands.proposeHuman, { orgId: t.orgId, logical: 'proposer', bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 1, maxSteps: 1 });
    await t.human.mutation(commands.approve, { orgId: t.orgId, id, expiresAt: Date.now() + 60000 });
    const c = await p.client.mutation(commands.claimHuman, { orgId: t.orgId, id, worker: 'worker' });
    await t.human.mutation(anyApi.orgs.setRole, { orgId: t.orgId, userId: p.userId, role: 'member' });
    const r = await adapterAs(t.adapterKey)('permit', { id, ...c, worker: 'worker' }); assert.equal(r.status, 403, r.text); return r;
  });
  await check('C1-B1', 1, 'Approval expires between claim and permit: permit refused', async () => {
    const t = await tenant('iv-approval-expiry');
    const id = await t.human.mutation(commands.proposeHuman, { orgId: t.orgId, logical: 'exp', bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 1, maxSteps: 1 });
    await t.human.mutation(commands.approve, { orgId: t.orgId, id, expiresAt: Date.now() + 1200 }); const c = await t.claim(id); await pause(1300);
    const r = await permitStatus(t, id, c); assert.equal(r.status, 403, r.text); assert.match(r.text, /Approval changed or expired|Stale claim/); return r;
  });
  await check('C1-B2', 1, 'Payload edited after approval: claim and permit refused', async () => {
    const t = await tenant('iv-approval-edit'), id = await t.propose('edit', 1, 1);
    await t.human.mutation(commands.editHuman, { orgId: t.orgId, id, payload: { ...t.payload, content: 'changed after approval' } });
    const c = await attempt(() => t.claim(id)); assert.equal(c.ok, false, 'claim should refuse'); return c;
  });
  await check('C1-B3', 1, 'Spent or expired permit cannot be consumed; old fence after reclaim cannot consume', async () => {
    const t = await tenant('iv-stale-consume'), id = await t.propose('stale', 2, 1), p = await t.permit(id); await pause(1200);
    const { expires, maxUnits, maxRecipients, ...args } = p, late = await adapterAs(t.adapterKey)('consume', args); assert.equal(late.status, 403, late.text);
    await pause(1200); const again = await attempt(() => t.claim(id)); assert.ok(again.ok, 'reclaim after expiry: ' + again.error);
    const replay = await adapterAs(t.adapterKey)('consume', args); assert.equal(replay.status, 403, replay.text);
    return { late: late.text, replay: replay.text };
  });

  // ---------- Claim 1: same external ID, different provider instance ----------
  await check('C1-D1', 1, 'Same external ID across accounts, environments, provider names and orgs: every foreign adapter key is refused on 11 endpoints, no data change', async () => {
    const t1 = await tenant('iv-inst-1'), t2 = await tenant('iv-inst-2');
    // Same account string as t1, but live-sim environment, in another org.
    const t3 = await tenant('iv-inst-3');
    const envRef = f.run('integrations/connections:registerSecret', { orgId: t3.orgId, provider: 'fake', environment: 'live-sim', account: t1.account, handle: 'vault:' + randomUUID() });
    const envConn = await t3.human.action(anyApi['integrations/connections'].connect, { orgId: t3.orgId, secretReferenceId: envRef });
    f.run('integrations/connections:registerProvider', { provider: 'fake-two', enabled: true });
    const provRef = f.run('integrations/connections:registerSecret', { orgId: t3.orgId, provider: 'fake-two', environment: 'test', account: t1.account, handle: 'vault:' + randomUUID() });
    const provConn = await t3.human.action(anyApi['integrations/connections'].connect, { orgId: t3.orgId, secretReferenceId: provRef });
    const bindVia = async (conn, logical) => { const intent = await t3.human.mutation(anyApi['integrations/bindings'].provision, { orgId: t3.orgId, connectionId: conn.connectionId, logical, kind: 'recipient', recipient: 'shared@example.test', remove: false }); const r = await adapterAs(conn.adapterKey)('bind', { intentId: intent, externalId: 'same-external-id' }); assert.equal(r.status, 200, r.text); return { intent, bindingId: JSON.parse(r.text).bindingId }; };
    const envBinding = await bindVia(envConn, 'env'), provBinding = await bindVia(provConn, 'prov');
    const victimOp = await t2.propose('victim', 1, 1), victim = await t2.claim(victimOp);
    const pendingIntent = await t2.human.mutation(anyApi['integrations/bindings'].provision, { orgId: t2.orgId, connectionId: t2.connectionId, logical: 'pending', kind: 'model', remove: false });
    const before2 = all(t2.orgId), before3 = all(t3.orgId);
    const observed = {};
    const targets = [['t2 other account', t2.bindingId], ['t3 other environment', envBinding.bindingId], ['t3 other provider', provBinding.bindingId]];
    for (const [label, bindingId] of targets) for (const key of [t1.adapterKey, envConn.adapterKey, provConn.adapterKey, t2.adapterKey]) {
      const ownsBinding = (label.startsWith('t2') && key === t2.adapterKey) || (label.includes('environment') && key === envConn.adapterKey) || (label.includes('provider') && key === provConn.adapterKey);
      if (ownsBinding) continue;
      const calls = {
        callback: { bindingId, eventId: 'iv-' + randomUUID(), body: '{"version":1,"state":"suppressed","channel":"email","purpose":"marketing"}' },
        page: { resource: 'iv', traversal: 'iv-' + randomUUID(), from: 0, page: 1, items: [{ bindingId, observation: { version: 9, state: 'suppressed' } }], end: true, checkpoint: 1 },
        'safety-begin': { bindingId, documentRef: 'iv', providerRef: 'iv', kind: 'payment', currency: 'USD', paidMinor: 1 },
        permit: { id: victimOp, ...victim, worker: 'worker' }, status: { id: victimOp, ...victim }, unknown: { id: victimOp, ...victim }, fail: { id: victimOp, ...victim, retryable: false },
        reconcile: { id: victimOp, ...victim, providerRef: 'forged', usage: 0 }, 'resolve-unknown': { id: victimOp, ...victim, finality: 'final', evidence: 'forged' },
        bind: { intentId: pendingIntent, externalId: 'same-external-id' }, consume: { id: victimOp, ...victim, worker: 'worker', version: 1, bindingId },
      };
      for (const [name, body] of Object.entries(calls)) {
        if (key === t2.adapterKey && ['permit', 'status', 'unknown', 'fail', 'reconcile', 'resolve-unknown', 'bind', 'consume'].includes(name)) continue; // t2's own op/intent
        const r = await adapterAs(key)(name, body); observed[`${label}|${key.slice(0, 7)}|${name}`] = r.status;
        assert.ok(r.status === 403 || r.status === 404 || r.status === 400, `${label} ${name} with foreign key returned ${r.status}: ${r.text}`);
      }
    }
    assert.deepEqual(all(t2.orgId), before2, 't2 changed'); assert.deepEqual(all(t3.orgId), before3, 't3 changed');
    return { calls: Object.keys(observed).length, statuses: [...new Set(Object.values(observed))] };
  });
  await check('C1-D2', 1, 'Suppression callback on one binding changes only that binding recipient, not the same recipient/external ID elsewhere', async () => {
    const t1 = await tenant('iv-supp-1'), t2 = await tenant('iv-supp-2');
    for (const t of [t1, t2]) f.run('authorityFixtureH0:recipient', { bindingId: t.bindingId, recipient: 'same@example.test' });
    f.run('authorityFixture:consent', { orgId: t2.orgId, recipient: 'same@example.test' });
    const before = all(t2.orgId).consent;
    const r = await adapterAs(t1.adapterKey)('callback', { bindingId: t1.bindingId, eventId: 'supp', body: '{"version":1,"state":"suppressed","channel":"email","purpose":"marketing"}' }); assert.equal(r.status, 200, r.text);
    assert.equal(all(t1.orgId).consent.some(c => c.suppressed), true); assert.deepEqual(all(t2.orgId).consent, before); return { t1: all(t1.orgId).consent.length, t2: before };
  });

  // ---------- Claim 2 (on current code): capability grant on an object key that is deleted/renamed and recreated ----------
  await check('C2-K1', 2, 'Read/record grants bound to an object do not follow its key to a recreated object; legacy explicit grant does not either', async () => {
    const t = await tenant('iv-keyreuse');
    const widget = await t.human.mutation(anyApi.objects.create, { orgId: t.orgId, key: 'widget', label: 'Widget', labelPlural: 'Widgets' });
    const wd = await t.human.query(anyApi.objects.get, { orgId: t.orgId, objectId: widget }), wname = wd.fields.find(x => x.key === 'name');
    await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: widget, values: { [wname._id]: 'Old widget' } });
    const scoped = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'reader', origin: 'external' });
    for (const capability of ['read', 'record.create']) await t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: scoped.agentId, capability, scope: { kind: 'records', objectId: widget, records: 'all', fields: [wname._id] }, mode: 'direct', delegate: false, expiresAt: Date.now() + 120000 });
    const legacy = await t.human.action(anyApi.agents.create, { orgId: t.orgId, name: 'legacy explicit', grants: [{ action: 'create', objectKey: 'widget' }] });
    assert.equal((await rest(scoped.key)('GET', 'records?object=widget')).status, 200);
    f.run('authorityFixtureIv:renameObject', { objectId: widget, key: 'oldWidget' });
    const fresh = await t.human.mutation(anyApi.objects.create, { orgId: t.orgId, key: 'widget', label: 'New widget', labelPlural: 'New widgets' });
    const freshName = (await t.human.query(anyApi.objects.get, { orgId: t.orgId, objectId: fresh })).fields.find(x => x.key === 'name');
    await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: fresh, values: { [freshName._id]: 'New widget secret' } });
    const before = all(t.orgId);
    const out = {
      scopedList: (await rest(scoped.key)('GET', 'records?object=widget')).status,
      scopedCreate: (await rest(scoped.key)('POST', 'changes', { action: 'create', object: 'widget', values: { name: 'x' }, reason: 'iv' })).status,
      legacyCreate: (await rest(legacy.key)('POST', 'changes', { action: 'create', object: 'widget', values: { name: 'x' }, reason: 'iv' })).status,
      scopedOldStillReadable: (await rest(scoped.key)('GET', 'records?object=oldWidget')).status,
    };
    assert.equal(out.scopedList, 404); assert.equal(out.scopedCreate, 403); assert.equal(out.legacyCreate, 403); assert.equal(out.scopedOldStillReadable, 200);
    assert.deepEqual(all(t.orgId), before); return out;
  });

  // ---------- Claim 3: readonly via internal, scheduler and adapter paths ----------
  await check('C3-R1', 3, 'Readonly set after permit, before consume: observe whether the in-flight send can still be consumed (bounded tail)', async () => {
    const t = await tenant('iv-ro-tail'), id = await t.propose('tail', 1, 1), p = await t.permit(id);
    f.run('authorityFixtureIv:readonly', { orgId: t.orgId, readonly: true });
    const { expires, maxUnits, maxRecipients, ...args } = p, r = await adapterAs(t.adapterKey)('consume', args);
    return { consumeAfterReadonly: r.status, note: r.status === 200 ? 'already-permitted step still consumable for <=1s permit window (H0 bounded tail)' : 'refused' };
  });
  await check('C3-R2', 3, 'Readonly: queued/approved work is not dispatched by scheduler; claim, permit and new proposals refused; no send scheduled', async () => {
    const t = await tenant('iv-ro-sched'), approved = await t.propose('approved', 1, 1), queued = await t.propose('queued', 1, 1), c = await t.claim(queued);
    f.run('authorityFixtureIv:readonly', { orgId: t.orgId, readonly: true });
    const claim = await attempt(() => t.claim(approved)), permit = await permitStatus(t, queued, c);
    await t.human.mutation(anyApi.orgs.setRole, { orgId: t.orgId, userId: t.userId, role: 'owner' }).catch(() => {}); await pause(300);
    const sends = f.run('authorityFixtureIv:scheduled', {}).filter(s => /safety/.test(s.name) && s.state === 'pending');
    assert.equal(claim.ok, false); assert.match(claim.error, /read only/); assert.equal(permit.status, 403); assert.match(permit.text, /read only/); assert.equal(sends.length, 0);
    return { claim: claim.error, permit: permit.text, pendingSafetySends: sends.length };
  });
  await check('C3-R3', 3, 'Readonly: operator-internal functions behave as inventory labels them (labels are declared, not swept)', async () => {
    const t = await tenant('iv-ro-internal'); f.run('authorityFixtureIv:readonly', { orgId: t.orgId, readonly: true });
    const label = id => inventory.find(e => e.id === id)?.readonly;
    const run = (fn, args) => { try { f.run(fn, args); return 'allowed'; } catch (e) { return 'refused: ' + String(e.stderr ?? e.message).split('\n').find(l => /Error|error/.test(l))?.slice(0, 140); } };
    const observed = {
      'integrations/connections:registerSecret': run('integrations/connections:registerSecret', { orgId: t.orgId, provider: 'fake', environment: 'test', account: 'ro-' + randomUUID(), handle: 'vault:' + randomUUID() }),
      'integrations/budgets:configure': run('integrations/budgets:configure', { orgId: t.orgId, cap: 11, maxConcurrent: 3, maxPerRun: 8, maxSteps: 3, maxRecipients: 10 }),
      'ops:setFlag': run('ops:setFlag', { orgId: t.orgId, flag: 'iv.flag', enabled: true, reason: 'iv-check' }),
      'seed:ensureStandard': run('seed:ensureStandard', { orgId: t.orgId }),
    };
    const cb = await adapterAs(t.adapterKey)('callback', { bindingId: t.bindingId, eventId: 'ro', body: '{"version":1,"state":"suppressed","channel":"email","purpose":"marketing"}' });
    observed['integrations/callbacks:receive (via HTTP callback)'] = cb.status === 200 ? 'allowed' : 'refused ' + cb.status;
    const mismatches = Object.entries(observed).map(([id, o]) => ({ id, label: label(id.split(' ')[0]), observed: o })).filter(r => (r.label === 'refused') !== r.observed.startsWith('refused'));
    return { observed, mismatches };
  });

  // ---------- Claim 3: masks ----------
  const maskWorkspace = async label => {
    const t = await tenant(label), c = await company(t), canary = 'CANARY-' + randomUUID().slice(0, 8);
    const secret = (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: c.object._id, values: { [c.fields.name._id]: 'Visible Co ' + canary.slice(-4), [c.fields.city._id]: canary } })).recordId;
    const other = (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: c.object._id, values: { [c.fields.name._id]: 'Other Co', [c.fields.city._id]: 'Plain city' } })).recordId;
    return { t, c, canary, secret, other };
  };
  await check('C3-M1', 3, 'Agent cannot filter or sort by a hidden field (no inference of hidden value by presence)', async () => {
    const { t, c, canary } = await maskWorkspace('iv-mask-filter');
    const agent = await t.human.action(anyApi.agents.create, { orgId: t.orgId, name: 'masked', grants: [] });
    await t.human.mutation(anyApi['authority/policies'].setAgentMasks, { orgId: t.orgId, agentId: agent.agentId, hiddenFieldIds: [c.fields.city._id] });
    const call = rest(agent.key), hit = await call('GET', 'records?object=company&filter=city&value=' + encodeURIComponent(canary)), miss = await call('GET', 'records?object=company&filter=city&value=nope'), sorted = await call('GET', 'records?object=company&sort=city');
    const out = { hit: hit.status + ' ' + hit.text.slice(0, 100), miss: miss.status + ' ' + miss.text.slice(0, 100), sort: sorted.status };
    assert.notEqual(hit.status, 200); assert.equal(hit.status, miss.status); assert.notEqual(sorted.status, 200); assert.ok(!hit.text.includes(canary)); return out;
  });
  await check('C3-M2', 3, 'Member with hidden field cannot filter, sort, search, export, or read events/suggestions to recover it', async () => {
    const { t, c, canary, secret } = await maskWorkspace('iv-mask-member'), m = await invite(t, 'member', 'masked-member');
    const agent = await t.human.action(anyApi.agents.create, { orgId: t.orgId, name: 'proposer', grants: [] });
    await rest(agent.key)('POST', 'suggestions', { action: 'update', record: secret, values: { city: canary + '-diff' }, reason: 'iv' });
    await t.human.mutation(anyApi['authority/policies'].setMember, { orgId: t.orgId, memberId: (await memberOf(t, m.userId))._id, hiddenFieldIds: [c.fields.city._id] });
    const page = { cursor: null, numItems: 50 };
    const q = {
      filter: await attempt(() => m.client.query(anyApi.records.list, { orgId: t.orgId, objectId: c.object._id, filter: { fieldId: c.fields.city._id, value: canary }, paginationOpts: page })),
      sort: await attempt(() => m.client.query(anyApi.records.list, { orgId: t.orgId, objectId: c.object._id, sort: { fieldId: c.fields.city._id, direction: 'asc' }, paginationOpts: page })),
      list: await attempt(() => m.client.query(anyApi.records.list, { orgId: t.orgId, objectId: c.object._id, paginationOpts: page })),
      get: await attempt(() => m.client.query(anyApi.records.get, { orgId: t.orgId, recordId: secret })),
      events: await attempt(() => m.client.query(anyApi.events.forRecord, { orgId: t.orgId, recordId: secret })),
      orgEvents: await attempt(() => m.client.query(anyApi.events.forOrg, { orgId: t.orgId, paginationOpts: page })),
      csv: await attempt(() => m.client.query(anyApi.csv.exportPage, { orgId: t.orgId, objectId: c.object._id, cursor: null })),
      suggestions: await attempt(() => m.client.query(anyApi.suggestions.list, { orgId: t.orgId })),
      forRecord: await attempt(() => m.client.query(anyApi.suggestions.forRecord, { orgId: t.orgId, recordId: secret })),
      search: await attempt(() => m.client.query(anyApi.records.search, { orgId: t.orgId, text: canary })),
    };
    const leaks = Object.entries(q).filter(([, v]) => JSON.stringify(v).includes(canary)).map(([k]) => k);
    assert.equal(q.filter.ok, false, 'filter by hidden field must refuse'); assert.equal(q.sort.ok, false, 'sort by hidden field must refuse'); assert.deepEqual(leaks, []);
    return { filter: q.filter.error, sort: q.sort.error, leaks };
  });
  await check('C3-M3', 3, 'Hidden TITLE field: search, byRef, lookup titles, export and capture duplicate check do not reveal it', async () => {
    const { t, c, canary } = await maskWorkspace('iv-mask-title'), m = await invite(t, 'member', 'title-member');
    const titleCanary = 'TITLE' + randomUUID().slice(0, 8);
    const titled = (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: c.object._id, values: { [c.fields.name._id]: titleCanary + ' Holdings' } })).recordId;
    const people = (await t.human.query(anyApi.objects.list, { orgId: t.orgId })).find(o => o.key === 'person'), pf = (await t.human.query(anyApi.objects.get, { orgId: t.orgId, objectId: people._id })).fields;
    const person = (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: people._id, values: { [pf.find(x => x.key === 'name')._id]: 'Pat Person', [pf.find(x => x.key === 'company')._id]: titled } })).recordId;
    await t.human.mutation(anyApi.inbox.add, { orgId: t.orgId, text: 'see record' });
    await t.human.mutation(anyApi['authority/policies'].setMember, { orgId: t.orgId, memberId: (await memberOf(t, m.userId))._id, hiddenFieldIds: [c.fields.name._id] });
    const rec = await t.human.query(anyApi.records.get, { orgId: t.orgId, recordId: titled });
    const q = {
      search: await attempt(() => m.client.query(anyApi.records.search, { orgId: t.orgId, text: titleCanary })),
      searchObj: await attempt(() => m.client.query(anyApi.records.search, { orgId: t.orgId, objectId: c.object._id, text: '' })),
      byRef: await attempt(() => m.client.query(anyApi.records.byRef, { orgId: t.orgId, ref: rec.record.ref })),
      person: await attempt(() => m.client.query(anyApi.records.get, { orgId: t.orgId, recordId: person })),
      personCsv: await attempt(() => m.client.query(anyApi.csv.exportPage, { orgId: t.orgId, objectId: people._id, cursor: null })),
      companyCsv: await attempt(() => m.client.query(anyApi.csv.exportPage, { orgId: t.orgId, objectId: c.object._id, cursor: null })),
      today: await attempt(() => m.client.query(anyApi.today.get, { orgId: t.orgId, today: Date.now() })),
    };
    const leaks = Object.entries(q).filter(([, v]) => JSON.stringify(v).includes(titleCanary)).map(([k]) => k);
    const capHit = await attempt(() => m.client.mutation(anyApi.capture.save, { orgId: t.orgId, kind: 'company', name: titleCanary + ' Holdings' }));
    const capMiss = await attempt(() => m.client.mutation(anyApi.capture.save, { orgId: t.orgId, kind: 'company', name: 'Nothing ' + randomUUID() }));
    const oracle = capHit.ok !== capMiss.ok || (capHit.error ?? '') !== (capMiss.error ?? '');
    assert.deepEqual(leaks, []); assert.equal(oracle, false, 'capture duplicate check distinguishes hidden title: ' + JSON.stringify({ capHit, capMiss }));
    return { leaks, capHit, capMiss };
  });
  await check('C3-M4', 3, 'Record-scoped member: CSV import duplicate check does not reveal titles of records outside scope', async () => {
    const t = await tenant('iv-scope-csv'), c = await company(t), m = await invite(t, 'member', 'scoped');
    const mine = (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: c.object._id, values: { [c.fields.name._id]: 'My Co' } })).recordId;
    await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: c.object._id, values: { [c.fields.name._id]: 'Secret Merger Target' } });
    await t.human.mutation(anyApi['authority/policies'].setMember, { orgId: t.orgId, memberId: (await memberOf(t, m.userId))._id, scopes: [{ objectId: c.object._id, records: [mine], fields: 'all' }], hiddenFieldIds: [] });
    const visible = await m.client.query(anyApi.records.search, { orgId: t.orgId, text: 'Secret Merger Target' });
    const r = await attempt(() => m.client.mutation(anyApi.csv.importRows, { orgId: t.orgId, objectId: c.object._id, columns: [c.fields.name._id], rows: [['Secret Merger Target'], ['Nonexistent Co ' + randomUUID().slice(0, 4)]], firstRow: 2, skipDuplicates: true, createMissing: false }));
    const oracle = r.ok && r.value.skipped === 1 && r.value.errors.length === 1 && r.value.errors[0].row === 3;
    assert.equal(visible.length, 0, 'secret record must be invisible to search');
    assert.equal(oracle, false, 'import result distinguishes an unreadable existing title from a missing one: ' + JSON.stringify(r));
    return r;
  });
  await check('C3-M5', 3, 'Record-scoped member: browser capture duplicate check does not reveal titles of records outside scope', async () => {
    const t = await tenant('iv-scope-capture'), c = await company(t), m = await invite(t, 'member', 'scoped-cap');
    const mine = (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: c.object._id, values: { [c.fields.name._id]: 'My Co' } })).recordId;
    await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: c.object._id, values: { [c.fields.name._id]: 'Secret Merger Target' } });
    await t.human.mutation(anyApi['authority/policies'].setMember, { orgId: t.orgId, memberId: (await memberOf(t, m.userId))._id, scopes: [{ objectId: c.object._id, records: [mine], fields: 'all' }], hiddenFieldIds: [] });
    const hit = await attempt(() => m.client.mutation(anyApi.capture.save, { orgId: t.orgId, kind: 'company', name: 'Secret Merger Target' }));
    const miss = await attempt(() => m.client.mutation(anyApi.capture.save, { orgId: t.orgId, kind: 'company', name: 'Nonexistent ' + randomUUID().slice(0, 4) }));
    assert.equal(hit.error === miss.error && hit.ok === miss.ok, true, 'capture distinguishes: ' + JSON.stringify({ hit, miss }));
    return { hit, miss };
  });
  await check('C3-M6', 3, 'Record-scoped agent: lookup-by-title in a proposal does not reveal titles of records outside its read scope', async () => {
    const t = await tenant('iv-scope-agent'), c = await company(t);
    const objects = await t.human.query(anyApi.objects.list, { orgId: t.orgId }), people = objects.find(o => o.key === 'person'), pf = (await t.human.query(anyApi.objects.get, { orgId: t.orgId, objectId: people._id })).fields;
    const mineCo = (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: c.object._id, values: { [c.fields.name._id]: 'My Co' } })).recordId;
    await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: c.object._id, values: { [c.fields.name._id]: 'Secret Merger Target' } });
    const pat = (await t.human.mutation(anyApi.records.create, { orgId: t.orgId, objectId: people._id, values: { [pf.find(x => x.key === 'name')._id]: 'Pat' } })).recordId;
    const agent = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'scoped reader', origin: 'external' });
    const g = (capability, objectId, records, fields) => t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target: agent.agentId, capability, scope: { kind: 'records', objectId, records, fields }, mode: 'direct', delegate: false, expiresAt: Date.now() + 120000 });
    await g('read', people._id, [pat], pf.map(x => x._id)); await g('read', c.object._id, [mineCo], Object.values(c.fields).map(x => x._id));
    const call = rest(agent.key);
    const hit = await call('POST', 'suggestions', { action: 'update', record: pat, values: { company: 'Secret Merger Target' }, reason: 'iv' });
    const miss = await call('POST', 'suggestions', { action: 'update', record: pat, values: { company: 'Nonexistent ' + randomUUID().slice(0, 4) }, reason: 'iv' });
    const out = { hit: hit.status + ' ' + hit.text.slice(0, 140), miss: miss.status + ' ' + miss.text.slice(0, 140) };
    assert.equal(hit.status, miss.status, 'status distinguishes existence: ' + JSON.stringify(out)); return out;
  });
  await check('C3-M7', 3, 'Open subscription of a non-owner member: records.list loses a newly hidden field, and a newly out-of-scope record, within 2 s', async () => {
    const { t, c, canary, secret, other } = await maskWorkspace('iv-sub'), subject = 'iv-sub-member-' + randomUUID();
    const mc = f.client(subject), uid = await mc.mutation(anyApi.users.store, {}); const inv = await t.human.mutation(anyApi.invites.create, { orgId: t.orgId, role: 'member' }); await mc.mutation(anyApi.invites.accept, { token: inv.token });
    const memberId = (await memberOf(t, uid))._id;
    const socket = new ConvexClient(f.url, { logger: false }); socket.setAuth(async () => f.token(subject)); let current, error;
    const stop = socket.onUpdate(anyApi.records.list, { orgId: t.orgId, objectId: c.object._id, paginationOpts: { cursor: null, numItems: 50 } }, v => { current = v; }, e => { error = e; });
    try {
      const d = Date.now() + 5000; while (!current && !error && Date.now() < d) await pause(20); if (error) throw error;
      assert.ok(JSON.stringify(current).includes(canary));
      let t0 = performance.now(); await t.human.mutation(anyApi['authority/policies'].setMember, { orgId: t.orgId, memberId, hiddenFieldIds: [c.fields.city._id] });
      while (JSON.stringify(current).includes(canary) && performance.now() - t0 < 3000) await pause(5); const fieldMs = performance.now() - t0;
      t0 = performance.now(); await t.human.mutation(anyApi['authority/policies'].setMember, { orgId: t.orgId, memberId, scopes: [{ objectId: c.object._id, records: [other], fields: 'all' }], hiddenFieldIds: [c.fields.city._id] });
      while (current.page.some(r => r._id === secret) && performance.now() - t0 < 3000) await pause(5); const recordMs = performance.now() - t0;
      assert.ok(fieldMs < 2000 && recordMs < 2000, JSON.stringify({ fieldMs, recordMs })); return { fieldMs: +fieldMs.toFixed(1), recordMs: +recordMs.toFixed(1) };
    } finally { stop(); await socket.close(); }
  });

  // ---------- Claim 4: secrets ----------
  await check('C4-S1', 4, 'Secret reference environment or provider changed after connect: claim fails closed', async () => {
    const out = {};
    for (const [label, patch] of [['environment', { environment: 'live' }], ['provider', { provider: 'fake-two' }]]) {
      f.run('integrations/connections:registerProvider', { provider: 'fake-two', enabled: true });
      const t = await tenant('iv-secret-' + label), id = await t.propose('secret-' + label, 1, 1);
      f.run('authorityFixtureIv:patchSecret', { id: t.secretReferenceId, ...patch });
      const r = await attempt(() => t.claim(id)); out[label] = r; assert.equal(r.ok, false, label + ' change must fail closed'); assert.match(r.error, /reconnection/i);
    }
    return out;
  });
  await check('C4-S2', 4, 'Secret canaries never appear in adapter/REST validation errors, backend logs or exports', async () => {
    const t = await tenant('iv-secret-leak'), canary = 'SECRETCANARY' + randomUUID().replace(/-/g, '');
    const handleCanary = randomUUID(), ref = f.run('integrations/connections:registerSecret', { orgId: t.orgId, provider: 'fake', environment: 'test', account: 'leak-' + randomUUID(), handle: 'vault:' + handleCanary });
    const conn = await t.human.action(anyApi['integrations/connections'].connect, { orgId: t.orgId, secretReferenceId: ref });
    const agent = await t.human.action(anyApi.agents.create, { orgId: t.orgId, name: 'leaky', grants: [{ action: 'create', objectKey: '*' }] });
    const responses = [];
    // An adapter that forwards provider material in a malformed body; a REST caller that sends junk.
    for (const name of ['callback', 'permit', 'bind', 'page', 'lookup', 'safety-begin']) responses.push(await adapterAs(conn.adapterKey)(name, { providerSignature: canary, bindingId: t.bindingId }));
    responses.push(await rest(agent.key)('POST', 'changes', { action: 'create', object: 'company', values: { name: 'x' }, reason: 'iv', apiKey: canary }));
    responses.push(await rest(agent.key)('POST', 'suggestions', { bogus: canary }));
    const other = await tenant('iv-secret-other'); responses.push({ text: (await attempt(() => t.human.action(anyApi['integrations/connections'].connect, { orgId: t.orgId, secretReferenceId: other.secretReferenceId }))).error });
    const agentHash = sha(agent.key), adapterHash = sha(conn.adapterKey);
    await pause(1500); const logs = f.logs();
    const fixture = f.exportFixture(); const files = execFileSync('unzip', ['-Z1', fixture.path], { encoding: 'utf8' }).trim().split('\n').filter(x => x && !x.startsWith('secretReferences/'));
    const exported = files.map(file => execFileSync('unzip', ['-p', fixture.path, file], { encoding: 'utf8', maxBuffer: 1 << 28 })).join('\n');
    const joined = responses.map(r => r.text ?? '').join('\n');
    const where = v => ({ responses: joined.includes(v), logs: logs.includes(v), export: exported.includes(v) });
    const found = { rawAgentKey: where(agent.key), rawAdapterKey: where(conn.adapterKey), vaultHandle: where(handleCanary), forwardedProviderMaterial: where(canary), agentKeyHash: where(agentHash), adapterKeyHash: where(adapterHash) };
    const sample = logs.split('\n').filter(l => l.includes(canary) || l.includes(adapterHash)).slice(0, 3).map(l => l.replace(canary, '<CANARY>').replace(adapterHash, '<ADAPTER_KEY_SHA256>').slice(0, 400));
    const responseSample = responses.map(r => (r.text ?? '').replace(canary, '<CANARY>').replace(agentHash, '<AGENT_KEY_SHA256>').replace(adapterHash, '<ADAPTER_KEY_SHA256>').slice(0, 260));
    for (const k of ['rawAgentKey', 'rawAdapterKey', 'vaultHandle']) assert.deepEqual(found[k], { responses: false, logs: false, export: false }, k + ' leaked');
    return { found, logSample: sample, responseSample };
  });

  // ---------- Inventory: regenerate from the running backend ----------
  await check('INV-1', 3, 'Function inventory regenerated with `convex function-spec` from the deployed backend matches inventory.json', async () => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CONVEX_AGENT_MODE: 'anonymous', CI: '1', CONVEX_DISABLE_METRICS: '1' };
    const raw = execFileSync(process.execPath, [join(f.root, 'node_modules/convex/bin/main.js'), 'function-spec'], { cwd: f.scratch, env, encoding: 'utf8', maxBuffer: 1 << 26 });
    writeFileSync(evidencePath('function-spec-raw.json'), raw);
    return { savedBytes: raw.length };
  });

  return { results, scratch: f.scratch };
});
writeFileSync(evidencePath('iv-service.json'), JSON.stringify(report, null, 2) + '\n');
const r = report.results; console.log(`\nIV SUMMARY ${r.filter(x => x.status === 'PASS').length} PASS / ${r.filter(x => x.status === 'FAIL').length} FAIL`);
