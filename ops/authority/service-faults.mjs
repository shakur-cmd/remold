import assert from 'node:assert/strict';
import { anyApi } from 'convex/server';
import { commands } from './service-fixture.mjs';
const pause = ms => new Promise(r => setTimeout(r, ms));
export async function replayFaults({ runtime, tenant, test }) {
  const final = (t, target) => t.human.mutation(anyApi['integrations/outcomes'].operatorResolveUnknown, { orgId: t.orgId, ...target, finality: 'final', evidence: 'synthetic owner final resolution' });
  await test('Concurrent duplicate logical proposals and claims yield one operation and reservation', async () => {
    const t = await tenant('logical-race'); const ids = await Promise.all([t.propose('same'), t.propose('same')]); assert.equal(ids[0], ids[1]);
    const race = await Promise.allSettled(ids.map(t.claim)); assert.equal(race.filter(r => r.status === 'fulfilled').length, 1); assert.equal(t.budget().reserved, 5); await t.cancel(ids[0]); assert.equal(t.budget().reserved, 0);
  });
  await test('Global spend, concurrency and per-run ceilings serialize across distinct tenants', async () => {
    const a = await tenant('global-a'), b = await tenant('global-b'), base = a.dump().budgets.find(b => b.key === 'global');
    const configure = patch => runtime.run('integrations/budgets:configure', { cap: 10000, maxConcurrent: 1000, maxPerRun: 1000, maxSteps: 5, maxRecipients: 100, ...patch });
    const ids = [await a.propose('a', 4), await b.propose('b', 4)]; configure({ cap: base.spent + base.reserved + 6 });
    const race = await Promise.allSettled([a.claim(ids[0]), b.claim(ids[1])]); assert.equal(race.filter(r => r.status === 'fulfilled').length, 1); await a.cancel(ids[0]); await b.cancel(ids[1]);
    configure({ maxConcurrent: base.active + 1 }); const one = await a.propose('one', 1), two = await b.propose('two', 1); const slots = await Promise.allSettled([a.claim(one), b.claim(two)]); assert.equal(slots.filter(r => r.status === 'fulfilled').length, 1); await a.cancel(one); await b.cancel(two);
    configure({ maxPerRun: 3 }); await assert.rejects(a.claim(await a.propose('per-run', 4)), /Per-run budget/); configure({});
  });
  await test('Continuation reduces per-call exposure and old fence cannot consume the next step', async () => {
    const t = await tenant('remaining'), id = await t.propose('steps'), first = await t.permit(id); assert.equal(first.maxUnits, 5); await t.consume(first);
    await t.adapter('reconcile', { id, fence: first.fence, step: first.step, providerRef: 'step1', usage: 2, continue: true }); const second = await t.permit(id); assert.equal(second.maxUnits, 3); assert.equal(second.step, 2);
    await assert.rejects(t.consume(first), /spent permit/); await t.consume(second); const exhausted = await t.adapter('reconcile', { id, fence: second.fence, step: second.step, providerRef: 'step2', usage: 3, continue: true });
    // The last allowed step asked to continue: it settles, refuses the continuation and frees its slot.
    assert.equal(exhausted.continuationRefused, true); assert.equal((await t.get(id)).state, 'confirmed'); assert.equal(t.budget().active, 0); assert.equal(t.budget().spent, 5);
    await assert.rejects(t.claim(id), /Operation stopped/);
  });
  await test('Final permit refuses expired approval without relying on asynchronous sweeps', async () => {
    const t = await tenant('approval-expiry'), id = await t.propose('expires'); await t.human.mutation(commands.approve, { orgId: t.orgId, id, expiresAt: Date.now() + 250 }); const c = await t.claim(id); await pause(300);
    await assert.rejects(t.adapter('permit', { id, ...c, worker: 'worker' }), /Approval changed or expired/); await t.cancel(id);
  });
  for (const path of ['failure', 'expiry', 'sweep']) await test('Unresolved prior consumed attempt survives ' + path + ' and releases only after final current-step absence', async () => {
    const t = await tenant('unresolved-' + path), id = await t.propose('unknown', 5, 1), first = await t.start(id); await t.adapter('unknown', first);
    await t.adapter('resolve-unknown', { ...first, finality: 'provisional', evidence: 'synthetic provisional lookup' }); const second = await t.permit(id);
    if (path === 'failure') await t.adapter('fail', { id, fence: second.fence, step: second.step, retryable: false });
    if (path === 'expiry') await pause(2300);
    if (path === 'sweep') { runtime.run('authorityFixture:bumpMember', { orgId: t.orgId, userId: t.userId }); runtime.run('integrations/lifecycle:sweep', { orgId: t.orgId, cursor: null }); await pause(2300); }
    assert.equal((await t.get(id)).state, 'outcomeUnknown'); assert.equal(t.budget().reserved, 5); assert.equal(t.budget().active, 1); await final(t, first); assert.equal(t.budget().active, 0);
  });
  for (const consumed of [false, true]) await test('Durable cancellation survives rejection and absence ' + consumed, async () => {
    const t = await tenant('cancel-path-' + consumed), id = await t.propose('cancel'), p = await t.permit(id), target = { id, fence: p.fence, step: p.step };
    if (consumed) await t.consume(p); await t.cancel(id); await t.adapter('fail', { ...target, retryable: true }); await assert.rejects(t.claim(id));
    if (consumed) { await t.adapter('resolve-unknown', { ...target, finality: 'provisional', evidence: 'synthetic lookup' }); assert.equal((await t.get(id)).state, 'outcomeUnknown'); await final(t, target); }
    assert.equal(t.budget().active, 0); await assert.rejects(t.claim(id));
  });
  for (const cancelled of [false, true]) await test('Unconsumed unknown does not manufacture provider uncertainty; expiry recovers ' + cancelled, async () => {
    const t = await tenant('unconsumed-' + cancelled), id = await t.propose('unknown'), p = await t.permit(id); if (cancelled) await t.cancel(id);
    await t.adapter('unknown', { id, fence: p.fence, step: p.step }); assert.notEqual((await t.get(id)).state, 'outcomeUnknown'); await pause(1300);
    assert.equal((await t.get(id)).state, cancelled ? 'cancelled' : 'queued'); if (!cancelled) await t.cancel(id); assert.equal(t.budget().active, 0);
  });
  for (const missing of [false, true]) await test('Single-step overrun remains confirmed and retained missing usage cannot be cancelled away ' + missing, async () => {
    const t = await tenant('single-overrun-' + missing), id = await t.propose('single', 2, 1), target = await t.start(id);
    if (missing) { await t.adapter('reconcile', { ...target, providerRef: 'accepted' }); await t.cancel(id); assert.equal(t.budget().reserved, 2); }
    await t.adapter('reconcile', { ...target, providerRef: 'accepted', usage: 3 }); assert.equal((await t.get(id)).state, 'confirmed'); assert.equal(t.budget().spent, 3); assert.equal(t.budget().active, 0);
  });
  await test('Invalid secret references and disabled account health fail closed without exposing opaque handles', async () => {
    const t = await tenant('secrets'), id = await t.propose('secret');
    await assert.rejects(t.human.action(anyApi['integrations/connections'].connect, { orgId: t.orgId, secretReferenceId: t.bindingId }));
    runtime.run('authorityFixture:revokeSecret', { id: t.secretReferenceId }); await assert.rejects(t.claim(id), /reconnection/);
    const listed = await t.human.query(anyApi['integrations/connections'].list, { orgId: t.orgId }); assert.ok(!JSON.stringify(listed).includes('vault:')); assert.ok(!JSON.stringify(t.dump().events).includes('vault:'));
  });
}
