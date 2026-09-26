import assert from 'node:assert/strict';
import { anyApi } from 'convex/server';
import { commands } from './service-fixture.mjs';
const pause = ms => new Promise(r => setTimeout(r, ms));
const stop = (t, id) => t.human.mutation(commands.cancelHuman, { orgId: t.orgId, id });
export async function replayOperations({ runtime, tenant, test }) {
  await test('SERVICE transaction races reserve organization budget and concurrency once', async () => {
    const t = await tenant('org-race'), ids = await Promise.all([t.propose('one', 6), t.propose('two', 6)]);
    const raced = await Promise.allSettled(ids.map(t.claim)); assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(t.budget().reserved, 6); for (const id of ids) await stop(t, id); assert.equal(t.budget().active, 0);
    const c = await tenant('concurrency', { cap: 100, maxConcurrent: 1 });
    const calls = await Promise.all([c.propose('one', 1), c.propose('two', 1)]); const claims = await Promise.allSettled(calls.map(c.claim)); assert.equal(claims.filter(r => r.status === 'fulfilled').length, 1);
    for (const id of calls) await stop(c, id);
  });
  await test('SERVICE cross-tenant collision leaves the losing account and organization unchanged', async () => {
    const a = await tenant('tuple-a'), b = await tenant('tuple-b');
    const ref = runtime.run('integrations/connections:registerSecret', { orgId: b.orgId, provider: 'fake', environment: 'test', account: a.account, handle: 'vault:00000000-0000-0000-0000-000000000002' });
    await assert.rejects(b.human.action(anyApi['integrations/connections'].connect, { orgId: b.orgId, secretReferenceId: ref }), /Account already bound/);
    const id = await a.propose('private'); await assert.rejects(b.get(id)); await assert.rejects(b.adapter('status', { id, fence: 0, step: 1 }));
    assert.equal(b.dump().operations.length, 0); await stop(a, id);
  });
  await test('Payload edits invalidate immutable approval; destination and schedule are enforced', async () => {
    const t = await tenant('approval'), id = await t.propose('edit');
    await t.human.mutation(commands.editHuman, { orgId: t.orgId, id, payload: { ...t.payload, content: 'edited' } }); await assert.rejects(t.claim(id), /Approval changed/);
    await assert.rejects(t.human.mutation(commands.editHuman, { orgId: t.orgId, id, payload: { ...t.payload, destination: 'other' } }), /Destination substitution/);
    const future = await t.propose('future', 1, 1, { payload: { ...t.payload, schedule: Date.now() + 60000 } }); await assert.rejects(t.permit(future), /Dispatch bounds/); await stop(t, future);
  });
  await test('One-use expiring permit and server scheduled crash recovery retain consumed uncertainty', async () => {
    const t = await tenant('expiry'), id = await t.propose('used'), permit = await t.permit(id);
    await t.consume(permit); await assert.rejects(t.consume(permit), /spent permit/);
    await pause(2300); assert.equal((await t.get(id)).state, 'outcomeUnknown'); assert.equal(t.budget().reserved, 5);
    const target = { id, fence: permit.fence, step: permit.step }; await t.adapter('reconcile', { ...target, providerRef: 'expired-late', usage: 1 }); assert.equal(t.budget().active, 0);
    const unused = await t.propose('unused'), p = await t.permit(unused); await pause(1250); await assert.rejects(t.consume(p), /spent permit/); assert.equal((await t.get(unused)).state, 'queued'); await stop(t, unused);
  });
  await test('Readonly between claim and permit stops sends but permits truthful receipt settlement', async () => {
    const t = await tenant('readonly'), id = await t.propose('before'), c = await t.claim(id);
    runtime.run('authorityFixture:flags', { orgId: t.orgId, readonly: true }); await assert.rejects(t.adapter('permit', { id, ...c, worker: 'worker' }), /read only/); await stop(t, id);
    runtime.run('authorityFixture:flags', { orgId: t.orgId, readonly: false }); const other = await t.propose('after'), target = await t.start(other);
    runtime.run('authorityFixture:flags', { orgId: t.orgId, readonly: true }); await t.adapter('reconcile', { ...target, providerRef: 'truth', usage: 1 }); assert.equal((await t.get(other)).state, 'confirmed'); assert.equal(t.budget().spent, 1);
  });
  await test('Missing usage pauses cheaper work until authoritative usage settles exactly once', async () => {
    const t = await tenant('missing'), id = await t.propose('missing', 6, 1), target = await t.start(id);
    await t.adapter('reconcile', { ...target, providerRef: 'missing' }); const cheap = await t.propose('cheap', 1, 1); await assert.rejects(t.claim(cheap), /Unresolved usage/);
    await t.adapter('reconcile', { ...target, providerRef: 'missing', usage: 2 }); await t.adapter('reconcile', { ...target, providerRef: 'missing', usage: 2 }); await t.claim(cheap);
    assert.equal(t.budget().spent, 2); assert.equal(t.budget().reserved, 1); await stop(t, cheap);
  });
  await test('Actual overrun records the full cost and blocks continuation and new spending', async () => {
    const t = await tenant('overrun'), id = await t.propose('overrun', 2), target = await t.start(id);
    const result = await t.adapter('reconcile', { ...target, providerRef: 'overrun', usage: 4, continue: true }); assert.equal(result.continuationRefused, true); assert.equal((await t.get(id)).state, 'paused');
    const budget = t.budget(); assert.equal(budget.spent, 4); assert.equal(budget.active, 0); assert.equal(budget.reserved, 0); assert.equal(budget.anomaly, 'usageOverrun');
    await assert.rejects(t.claim(await t.propose('next', 1, 1)), /anomaly hold/);
  });
  await test('Final absence targets only the current unresolved logical step, then late truth is held as anomaly', async () => {
    const t = await tenant('stale-finality'), id = await t.propose('steps'), first = await t.start(id);
    await t.adapter('reconcile', { ...first, providerRef: 'step1', usage: 1, continue: true }); const second = await t.start(id); await t.adapter('unknown', second);
    for (const finality of ['provisional', 'final']) await assert.rejects(t.human.mutation(anyApi['integrations/outcomes'].operatorResolveUnknown, { orgId: t.orgId, ...first, finality, evidence: 'synthetic operator evidence' }), /current unknown step/);
    assert.equal(t.budget().reserved, 4);
    await assert.rejects(t.adapter('resolve-unknown', { ...second, finality: 'final', evidence: 'unproven adapter string' }), /finality is not proven/);
    await t.human.mutation(anyApi['integrations/outcomes'].operatorResolveUnknown, { orgId: t.orgId, ...second, finality: 'final', evidence: 'synthetic owner override' });
    assert.equal(t.budget().active, 0); await t.adapter('reconcile', { ...second, providerRef: 'late-step2', usage: 2 }); await t.adapter('reconcile', { ...second, providerRef: 'late-step2', usage: 2 });
    assert.equal(t.budget().spent, 3); assert.equal(t.budget().reserved, 0); assert.equal(t.budget().anomaly, 'acceptedAfterFinalAbsence');
  });
  await test('Provisional absence permits only same-key retry and old-fence truthful settlement', async () => {
    const t = await tenant('provisional'), id = await t.propose('retry', 5, 1), firstPermit = await t.permit(id), firstSend = await t.consume(firstPermit);
    const first = { id, fence: firstPermit.fence, step: firstPermit.step }; await t.adapter('unknown', first);
    await t.adapter('resolve-unknown', { ...first, finality: 'provisional', evidence: 'provider lookup currently absent; no finality claimed' }); assert.equal(t.budget().reserved, 5);
    const secondPermit = await t.permit(id), secondSend = await t.consume(secondPermit); assert.equal(firstSend.key, secondSend.key);
    await t.adapter('fail', { id, fence: secondPermit.fence, step: secondPermit.step, retryable: false }); assert.equal((await t.get(id)).state, 'outcomeUnknown');
    await t.human.mutation(anyApi['integrations/outcomes'].operatorResolveUnknown, { orgId: t.orgId, ...first, finality: 'final', evidence: 'old fence, same logical step authoritative override' }); assert.equal(t.budget().active, 0);
  });
  await test('Receipt collisions persist a durable anomaly instead of rolling it back with an exception', async () => {
    const t = await tenant('collision'), id = await t.propose('collision'), target = await t.start(id);
    await t.adapter('reconcile', { ...target, providerRef: 'first', usage: 1 });
    const result = await t.adapter('reconcile', { ...target, providerRef: 'different', usage: 1 }); assert.equal(result.accepted, false); assert.equal(t.budget().anomaly, 'providerResultCollision'); assert.equal(t.budget().spent, 1);
  });
}
