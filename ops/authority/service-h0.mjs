import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { anyApi } from 'convex/server';
import { commands } from './service-fixture.mjs';

// Every refusal names its reason so a test cannot pass on an unrelated error (argument shape, typo).
const refuse = async (promise, pattern) => {
  try { await promise; } catch (error) { const text = String(error?.message ?? error); if (process.env.I1_TRACE) console.log('REFUSED', text.slice(0, 240)); if (pattern) assert.match(text, pattern); return text; }
  assert.fail('Missing expected rejection');
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const keyHash = key => createHash('sha256').update(key).digest('hex');
const agentApi = (runtime, key) => async (method, path, body) => {
  const response = await fetch(runtime.site + '/api/v1/' + path, { method, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(response.status + ':' + JSON.stringify(value));
  return value;
};
const grant = (t, target, capability = 'model.call', scope = { kind: 'model', maxUnitsPerRun: 5, maxSteps: 2 }, extra = {}) => t.human.mutation(anyApi['authority/grants'].grant, { orgId: t.orgId, target, capability, scope, mode: 'direct', delegate: true, expiresAt: Date.now() + 60000, ...extra });
const absence = (t, target, finality = 'provisional') => t.adapter('resolve-unknown', { ...target, finality, evidence: 'synthetic authoritative provider lookup' });

export async function replayH0Parity({ runtime, tenant, test }) {
  await test('H0#1 H0#9 cross-connection adapters cannot touch another connection tuple', async () => {
    const t = await tenant('h0-cross'), foreign = await tenant('h0-cross-foreign');
    const liveSecret = runtime.run('integrations/connections:registerSecret', { orgId: t.orgId, provider: 'fake', environment: 'live-sim', account: 'h0-live', handle: 'vault:' + randomUUID() });
    const one = await t.human.action(anyApi['integrations/connections'].connect, { orgId: t.orgId, secretReferenceId: liveSecret });
    const intentId = await t.human.mutation(anyApi['integrations/bindings'].provision, { orgId: t.orgId, connectionId: one.connectionId, logical: 'h0', kind: 'model', remove: false });
    const adapter = async (key, name, body) => { const r = await fetch(runtime.site + '/api/integrations/v1/' + name, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(body) }); if (r.ok) throw new Error(name + ' unexpectedly succeeded'); assert.ok([403, 404].includes(r.status), name + ' returned ' + r.status); };
    const binding = await (async () => { const r = await fetch(runtime.site + '/api/integrations/v1/bind', { method: 'POST', headers: { authorization: 'Bearer ' + one.adapterKey, 'content-type': 'application/json' }, body: JSON.stringify({ intentId, externalId: 'h0-live' }) }); return (await r.json()).bindingId; })();
    const twoKey = 'ra_' + randomBytes(32).toString('hex'); runtime.run('authorityFixtureH0:cloneConnection', { connectionId: one.connectionId, credentialHash: keyHash(twoKey) });
    const id = await t.human.mutation(commands.proposeHuman, { orgId: t.orgId, logical: 'h0-cross', bindingId: binding, capability: 'model.call', payload: { ...t.payload, destination: 'h0-live' }, reservationUnits: 1, maxSteps: 1 });
    await t.human.mutation(commands.approve, { orgId: t.orgId, id, expiresAt: Date.now() + 60000 }); const claimed = await t.human.mutation(commands.claimHuman, { orgId: t.orgId, id, worker: 'h0' }); const before = t.dump();
    for (const key of [t.adapterKey, twoKey, foreign.adapterKey]) {
      for (const [name, body] of [
        ['permit', { id, ...claimed, worker: 'h0' }], ['consume', { id, ...claimed, worker: 'h0', version: 1, bindingId: binding }], ['reconcile', { id, ...claimed, providerRef: 'x', usage: 1 }], ['unknown', { id, ...claimed }], ['fail', { id, ...claimed, retryable: true }], ['resolve-unknown', { id, ...claimed, finality: 'provisional', evidence: 'synthetic' }],
        ['callback', { bindingId: binding, eventId: 'h0', body: '{"version":1,"state":"subscribed"}' }], ['page', { resource: 'h0', traversal: 'h0', from: 0, page: 1, items: [{ bindingId: binding, observation: { version: 1, state: 'subscribed' } }], end: true, checkpoint: 1 }], ['bind', { intentId, externalId: 'wrong' }],
      ]) await adapter(key, name, body);
    }
    assert.deepEqual(t.dump(), before);
  });

  await test('H0#1 foreign owners cannot mutate known IDs and actor injection is rejected', async () => {
    const a = await tenant('h0-owner-a'), b = await tenant('h0-owner-b');
    const agent = await a.human.action(anyApi.agents.createScoped, { orgId: a.orgId, name: 'agent', origin: 'external' }); const g = await grant(a, agent.agentId);
    const id = await a.propose('life', 1, 1), before = b.dump();
    for (const action of [
      () => b.human.mutation(commands.approve, { orgId: b.orgId, id, expiresAt: Date.now() + 1 }), () => b.human.mutation(commands.claimHuman, { orgId: b.orgId, id, worker: 'x' }), () => b.human.mutation(commands.cancelHuman, { orgId: b.orgId, id }), () => b.human.mutation(commands.editHuman, { orgId: b.orgId, id, payload: b.payload }),
      () => b.human.mutation(anyApi['authority/grants'].revoke, { orgId: b.orgId, id: g }), () => b.human.mutation(anyApi.agents.revoke, { orgId: b.orgId, agentId: agent.agentId }),
    ]) await refuse(action(), /NOT_FOUND/);
    await refuse(a.human.mutation(commands.proposeHuman, { orgId: a.orgId, logical: 'forged', bindingId: a.bindingId, capability: 'model.call', payload: a.payload, reservationUnits: 1, maxSteps: 1, actor: { kind: 'user', id: a.userId } }), /extra field `actor`/);
    assert.deepEqual(b.dump(), before);
  });

  await test('H0#4 H0#5 H0#13 H0#16 H0#29 stale delegated fences fail while an independent root survives', async () => {
    for (const change of ['revoke', 'fire', 'continuation-fire', 'retry-fire']) {
      const t = await tenant('h0-fence-' + change), manager = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'manager', origin: 'external' }), child = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'child', origin: 'external' });
      const manage = await grant(t, manager.agentId, 'agent.manage', { kind: 'agents', agents: [child.agentId] }); const parent = await grant(t, manager.agentId);
      const managerCall = agentApi(runtime, manager.key), childCall = agentApi(runtime, child.key);
      await managerCall('POST', 'authority/grant', { target: child.agentId, capability: 'model.call', scope: { kind: 'model', maxUnitsPerRun: 5, maxSteps: 2 }, mode: 'direct', delegate: true, expiresAt: Date.now() + 30000, parent });
      await grant(t, child.agentId, 'social.publish', { kind: 'bindings', bindings: [t.bindingId], currency: 'USD', maxAmountMinor: 1, maxRecipients: 1 });
      const id = await childCall('POST', 'operations', { logical: change, bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 1, maxSteps: 2 }); const c = await childCall('POST', 'operations/' + id + '/claim', { worker: 'child' });
      if (change === 'revoke') await t.human.mutation(anyApi['authority/grants'].revoke, { orgId: t.orgId, id: parent });
      if (change === 'fire') await t.human.mutation(anyApi.agents.revoke, { orgId: t.orgId, agentId: manager.agentId });
      let held = c;
      // Continuation and retry both hand out a fresh fence; the stale-authority check must apply to that new claim too.
      if (change === 'continuation-fire') { const p = await t.adapter('permit', { id, ...c, worker: 'child' }); await t.consume(p); await t.adapter('reconcile', { id, ...c, providerRef: 'one', usage: 0, continue: true }); held = await childCall('POST', 'operations/' + id + '/claim', { worker: 'child' }); assert.equal(held.step, c.step + 1); await t.human.mutation(anyApi.agents.revoke, { orgId: t.orgId, agentId: manager.agentId }); }
      if (change === 'retry-fire') { await t.adapter('permit', { id, ...c, worker: 'child' }); await t.adapter('fail', { id, ...c, retryable: true }); held = await childCall('POST', 'operations/' + id + '/claim', { worker: 'child' }); assert.ok(held.fence > c.fence); await t.human.mutation(anyApi.agents.revoke, { orgId: t.orgId, agentId: manager.agentId }); }
      await refuse(t.adapter('permit', { id, ...held, worker: 'child' }), /External capability denied/);
      const independent = await childCall('POST', 'operations', { logical: 'independent-' + change, bindingId: t.bindingId, capability: 'social.publish', payload: { ...t.payload, amountMinor: 0 }, reservationUnits: 1, maxSteps: 1 }); await childCall('POST', 'operations/' + independent + '/claim', { worker: 'child' });
      void manage;
    }
  });

  await test('H0#7 expired grant denies final permit without a lifecycle sweep', async () => {
    const t = await tenant('h0-expiry'), agent = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'expiry', origin: 'external' });
    await grant(t, agent.agentId, 'model.call', { kind: 'model', maxUnitsPerRun: 1, maxSteps: 1 }, { expiresAt: Date.now() + 1500 }); const call = agentApi(runtime, agent.key);
    const id = await call('POST', 'operations', { logical: 'expiry', bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 1, maxSteps: 1 }); const c = await call('POST', 'operations/' + id + '/claim', { worker: 'x' }); await pause(1600); await refuse(t.adapter('permit', { id, ...c, worker: 'x' }), /External capability denied/);
  });

  await test('H0#2 H0#3 delegation cannot widen limits, manage outside scope, or return to an ancestor', async () => {
    const t = await tenant('h0-delegation'), manager = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'manager', origin: 'external' }), child = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'child', origin: 'external' });
    const root = await grant(t, manager.agentId, 'social.publish', { kind: 'bindings', bindings: [t.bindingId], currency: 'USD', maxAmountMinor: 1, maxRecipients: 1 }); const call = agentApi(runtime, manager.key);
    await refuse(call('POST', 'authority/grant', { target: child.agentId, capability: 'social.publish', scope: { kind: 'bindings', bindings: [t.bindingId], currency: 'USD', maxAmountMinor: 1, maxRecipients: 1 }, mode: 'direct', delegate: false, expiresAt: Date.now() + 10000, parent: root }), /Outside managed subtree/);
    await grant(t, manager.agentId, 'agent.manage', { kind: 'agents', agents: [child.agentId] }); const delegated = await call('POST', 'authority/grant', { target: child.agentId, capability: 'social.publish', scope: { kind: 'bindings', bindings: [t.bindingId], currency: 'USD', maxAmountMinor: 1, maxRecipients: 1 }, mode: 'direct', delegate: true, expiresAt: Date.now() + 10000, parent: root });
    await refuse(call('POST', 'authority/grant', { target: child.agentId, capability: 'social.publish', scope: { kind: 'bindings', bindings: [t.bindingId], currency: 'EUR', maxAmountMinor: 1, maxRecipients: 1 }, mode: 'direct', delegate: false, expiresAt: Date.now() + 10000, parent: root }), /Delegation exceeds parent/);
    await refuse(call('POST', 'authority/grant', { target: child.agentId, capability: 'social.publish', scope: { kind: 'bindings', bindings: [t.bindingId], currency: 'USD', maxAmountMinor: 2, maxRecipients: 1 }, mode: 'direct', delegate: false, expiresAt: Date.now() + 10000, parent: root }), /Delegation exceeds parent/);
    await refuse(agentApi(runtime, child.key)('POST', 'authority/grant', { target: manager.agentId, capability: 'social.publish', scope: { kind: 'bindings', bindings: [t.bindingId], currency: 'USD', maxAmountMinor: 1, maxRecipients: 1 }, mode: 'direct', delegate: false, expiresAt: Date.now() + 10000, parent: delegated }), /Cannot manage an ancestor/);
    await refuse(t.human.mutation(commands.proposeHuman, { orgId: t.orgId, logical: 'fraction', bindingId: t.bindingId, capability: 'model.call', payload: { ...t.payload, amountMinor: 1.5 }, reservationUnits: 1, maxSteps: 1 }), /Invalid bounded operation payload/);
  });

  await test('H0#15 H0#24 H0#25 H0#36 H0#37 absence and overrun hold claims until an operator clears the anomaly', async () => {
    // Firing, then provisional absence: the fired actor cannot be revalidated, so the op stays unknown and no permit can be issued.
    const t = await tenant('h0-anomaly'), agent = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'fired', origin: 'external' }); await grant(t, agent.agentId);
    const call = agentApi(runtime, agent.key), fired = await call('POST', 'operations', { logical: 'fired', bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 1, maxSteps: 1 });
    const fc = await call('POST', 'operations/' + fired + '/claim', { worker: 'x' }), fp = await t.adapter('permit', { id: fired, ...fc, worker: 'x' }); await t.consume(fp);
    const firedTarget = { id: fired, fence: fp.fence, step: fp.step }; await t.adapter('unknown', firedTarget);
    await t.human.mutation(anyApi.agents.revoke, { orgId: t.orgId, agentId: agent.agentId }); await absence(t, firedTarget);
    assert.equal((await t.get(fired)).state, 'outcomeUnknown'); await refuse(t.adapter('permit', { ...firedTarget, worker: 'x' }), /Stale claim/);
    // Terminal rejection of an unconsumed permit releases its reservation.
    const rejected = await t.propose('rejected', 1, 1), rp = await t.permit(rejected), reservedBefore = t.budget().reserved;
    await t.adapter('fail', { id: rejected, fence: rp.fence, step: rp.step, retryable: false });
    assert.equal((await t.get(rejected)).state, 'refused'); assert.equal(t.budget().reserved, reservedBefore - 1); await refuse(t.claim(rejected), /Operation stopped/);
    // Late truth after provisional absence settles exactly once.
    const late = await t.propose('late', 1, 1), lt = await t.start(late); await t.adapter('unknown', lt); await absence(t, lt);
    const spent = t.budget().spent; await t.adapter('reconcile', { ...lt, providerRef: 'late-once', usage: 1 }); await t.adapter('reconcile', { ...lt, providerRef: 'late-once', usage: 1 });
    assert.equal(t.budget().spent, spent + 1);
    // Acceptance after operator-final absence holds new claims until the anomaly is cleared.
    const held = await t.propose('final', 1, 1), ht = await t.start(held); await t.adapter('unknown', ht);
    await t.human.mutation(anyApi['integrations/outcomes'].operatorResolveUnknown, { orgId: t.orgId, id: held, fence: ht.fence, step: ht.step, finality: 'final', evidence: 'synthetic operator review' });
    await t.adapter('reconcile', { ...ht, providerRef: 'after-final', usage: 1 }); assert.equal((await t.get(held)).anomaly, 'acceptedAfterFinalAbsence');
    const next = await t.propose('next', 1, 1); await refuse(t.claim(next), /anomaly hold/);
    runtime.run('integrations/budgets:clearAnomaly', { orgId: t.orgId }); await t.claim(next);
    // A single-step overrun stays confirmed and also holds new work.
    const over = await tenant('h0-overrun'), oid = await over.propose('over', 1, 1), ot = await over.start(oid);
    await over.adapter('reconcile', { ...ot, providerRef: 'over', usage: 3 }); assert.equal((await over.get(oid)).state, 'confirmed'); assert.equal((await over.get(oid)).anomaly, 'usageOverrun');
    await refuse(over.claim(await over.propose('after-over', 1, 1)), /anomaly hold/);
  });

  await test('H0#30 H0#31 H0#32 H0#33 global exposure holds a second tenant until late truth settles', async () => {
    const a = await tenant('h0-global-a'), b = await tenant('h0-global-b'), global = a.dump().budgets.find(budget => budget.key === 'global'); runtime.run('integrations/budgets:configure', { cap: global.spent + global.reserved + 1, maxConcurrent: global.active + 5, maxPerRun: 8, maxSteps: 3, maxRecipients: 10 });
    const id = await a.propose('a', 1, 1), target = await a.start(id); await a.adapter('unknown', target); await absence(a, target); const blocked = await b.propose('b', 1, 1); await refuse(b.claim(blocked), /Budget or concurrency cap/); await a.adapter('reconcile', { ...target, providerRef: 'late', usage: 0 }); await b.claim(blocked);
    runtime.run('integrations/budgets:configure', { cap: 10000, maxConcurrent: 1000, maxPerRun: 1000, maxSteps: 5, maxRecipients: 100 });
  });

  await test('H0#18 H0#19 readonly accepts suppression and adoption after a fired agent', async () => {
    const t = await tenant('h0-readonly'), id = await t.propose('cancel', 1, 1); runtime.run('authorityFixtureH0:recipient', { bindingId: t.bindingId, recipient: 'h0@example.test' }); runtime.run('authorityFixture:flags', { orgId: t.orgId, readonly: true });
    await t.adapter('callback', { bindingId: t.bindingId, eventId: 's', body: '{"version":1,"state":"suppressed","channel":"email","purpose":"marketing"}' }); assert.equal(t.dump().consent[0].suppressed, true); await t.cancel(id);
    await refuse(t.human.mutation(commands.proposeHuman, { orgId: t.orgId, logical: 'refused', bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 1, maxSteps: 1 }), /read only/);
    const adoption = await tenant('h0-adoption'), agent = await adoption.human.action(anyApi.agents.createScoped, { orgId: adoption.orgId, name: 'author', origin: 'external' }); await grant(adoption, agent.agentId); const original = await agentApi(runtime, agent.key)('POST', 'operations', { logical: 'original', bindingId: adoption.bindingId, capability: 'model.call', payload: adoption.payload, reservationUnits: 1, maxSteps: 1 }); await adoption.human.mutation(anyApi.agents.revoke, { orgId: adoption.orgId, agentId: agent.agentId }); await refuse(adoption.human.mutation(commands.approve, { orgId: adoption.orgId, id: original, expiresAt: Date.now() + 1 }), /Agent inactive/); assert.ok(await adoption.human.mutation(commands.adopt, { orgId: adoption.orgId, id: original, logical: 'adopted' }));
  });

  await test('H0#21 H0#23 H0#27 cursors, cancellation and consent isolation stay fenced', async () => {
    const a = await tenant('h0-cursor-a'), b = await tenant('h0-cursor-b'); runtime.run('authorityFixtureH0:recipient', { bindingId: b.bindingId, recipient: 'b@example.test' }); await a.adapter('page', { resource: 'h0', traversal: 'one', from: 0, page: 1, items: [], end: true, checkpoint: 2 }); await refuse(a.adapter('page', { resource: 'h0', traversal: 'two', from: 2, page: 1, items: [], end: true, checkpoint: 1 }), /regression/);
    const id = await a.propose('cancel', 1, 1), target = await a.start(id); await a.cancel(id); assert.equal((await a.adapter('status', target)).cancel, true); await a.adapter('reconcile', { ...target, providerRef: 'late', usage: 1 }); assert.ok(a.dump().events.some(e => e.name === 'completedAfterCancellation'));
    const before = a.dump().consent; await b.adapter('callback', { bindingId: b.bindingId, eventId: 'b', body: '{"version":1,"state":"suppressed","channel":"email","purpose":"marketing"}' }); assert.deepEqual(a.dump().consent, before);
  });

  await test('H0#6 H0#14 agents cannot read foreign operations and a reclaimed fence rejects the old permit', async () => {
    const t = await tenant('h0-read-fence'), agent = await t.human.action(anyApi.agents.createScoped, { orgId: t.orgId, name: 'reader', origin: 'external' }); await grant(t, agent.agentId); const call = agentApi(runtime, agent.key);
    const own = await call('POST', 'operations', { logical: 'own', bindingId: t.bindingId, capability: 'model.call', payload: t.payload, reservationUnits: 1, maxSteps: 1 }); await refuse(call('GET', 'operations/' + (await t.propose('human', 1, 1))), /404/); const c = await call('POST', 'operations/' + own + '/claim', { worker: 'x' }); const p = await t.adapter('permit', { id: own, ...c, worker: 'x' }); await t.consume(p); await t.human.mutation(anyApi.agents.revoke, { orgId: t.orgId, agentId: agent.agentId }); await refuse(call('GET', 'operations/' + own), /Invalid or revoked agent key/);
    const recovery = await tenant('h0-reclaim'), recoveryAgent = await recovery.human.action(anyApi.agents.createScoped, { orgId: recovery.orgId, name: 'reclaim', origin: 'external' }); await grant(recovery, recoveryAgent.agentId); const recoveryCall = agentApi(runtime, recoveryAgent.key); const recovered = await recoveryCall('POST', 'operations', { logical: 'reclaim', bindingId: recovery.bindingId, capability: 'model.call', payload: recovery.payload, reservationUnits: 1, maxSteps: 1 }); const first = await recoveryCall('POST', 'operations/' + recovered + '/claim', { worker: 'x' }); const issued = await recovery.adapter('permit', { id: recovered, ...first, worker: 'x' }); await recovery.consume(issued); await recovery.adapter('unknown', { id: recovered, ...first }); await absence(recovery, { id: recovered, ...first }); const next = await recoveryCall('POST', 'operations/' + recovered + '/claim', { worker: 'x' }); assert.ok(next.fence > first.fence); await refuse(recovery.adapter('permit', { id: recovered, ...first, worker: 'x' }), /Stale claim/);
  });

  await test('H0#42 H0#43 old consumed fence for the same unresolved step still supports provisional absence', async () => {
    const t = await tenant('h0-old-fence'), id = await t.propose('old-fence', 5, 1), first = await t.start(id);
    await t.adapter('unknown', first); await absence(t, first); assert.equal((await t.get(id)).state, 'queued');
    const second = await t.start(id); await t.adapter('unknown', second);
    assert.notEqual(first.fence, second.fence); assert.equal(first.step, second.step);
    const reserved = t.budget().reserved;
    await absence(t, first);
    if (process.env.I1_TRACE) console.log('OLD-FENCE', JSON.stringify({ state: (await t.get(id)).state, reserved: t.budget().reserved, before: reserved }));
    assert.equal((await t.get(id)).state, 'queued'); assert.equal(t.budget().reserved, reserved);
    await t.cancel(id);
    const resolve = target => t.human.mutation(anyApi['integrations/outcomes'].operatorResolveUnknown, { orgId: t.orgId, id, fence: target.fence, step: target.step, finality: 'final', evidence: 'synthetic operator review' });
    await resolve(first); await resolve(second);
    assert.equal(t.budget().reserved, reserved - 5);
  });
}
