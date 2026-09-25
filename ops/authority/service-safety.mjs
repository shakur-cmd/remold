import assert from 'node:assert/strict';
import { financial } from './service-fixture.mjs';
import { anyApi } from 'convex/server';
const safety = anyApi['integrations/safety'], outcomes = anyApi['integrations/outcomes'];
const pause = ms => new Promise(r => setTimeout(r, ms));
export async function replaySafety({ runtime, tenant, test }) {
  const setup = async (name, kind = 'payment') => {
    const t = await tenant(name);
    const finance = await financial(t, kind), { targetId } = finance;
    runtime.run('authorityFixture:flags', { orgId: t.orgId, readonly: true });
    const prepare = (logical, amountMinor = 6) => t.human.mutation(safety.prepare, { orgId: t.orgId, targetId, logical, kind: kind === 'payment' ? 'refund' : 'cancelRecurring', amountMinor });
    const consume = id => t.human.mutation(safety.consume, { orgId: t.orgId, id });
    return { ...t, ...finance, prepare, consume };
  };
  await test('Readonly safety refund races reserve paid headroom transactionally; receipts settle once (SIM provider)', async () => {
    const t = await setup('safety-race'), ids = await Promise.all([t.prepare('one'), t.prepare('two')]);
    const race = await Promise.allSettled(ids.map(t.consume)); assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
    const id = ids[race.findIndex(r => r.status === 'fulfilled')]; assert.equal((await t.consume(id)).duplicate, true);
    await pause(500); assert.equal((await t.get(id)).state, 'outcomeUnknown');
    await assert.rejects(t.human.mutation(outcomes.operatorResolveUnknown, { orgId: t.orgId, id, fence: 1, step: 1, finality: 'final', evidence: 'operator guess' }), /provider lookup/);
    await assert.rejects(t.adapter('safety-resolve-unknown', { id, lookupId: t.dump().safetyTargets[0].lookupId }), /finality lookup/);
    await t.receipt(id, 'synthetic-refund', 6); await t.receipt(id, 'synthetic-refund', 6);
    await assert.rejects(t.consume(await t.prepare('over', 5)), /remaining paid/);
  });
  await test('Human safety rejects expired JWT and same-transaction membership epoch changes (SIM provider)', async () => {
    const t = await setup('safety-identity'), id = await t.prepare('epoch');
    const expired = runtime.client('unknown-human', { exp: 1 }); await assert.rejects(expired.mutation(safety.consume, { orgId: t.orgId, id }));
    runtime.run('authorityFixture:bumpMember', { orgId: t.orgId, userId: t.userId }); await assert.rejects(t.consume(id), /authority changed/);
  });
  await test('Client recurring cancel is a distinct zero-amount command with no new collection authority (SIM provider)', async () => {
    const t = await setup('safety-cancel', 'clientRecurring'); await assert.rejects(t.prepare('positive', 1), /Invalid safety/);
    const id = await t.prepare('cancel', 0); await t.consume(id); assert.equal((await t.get(id)).capability, 'billing.cancelRecurring');
    await t.receipt(id, 'synthetic-cancel', 0, 'pending'); const second = await t.prepare('second', 0);
    await assert.rejects(t.consume(second), /cancellation unavailable/);
    await t.receipt(id, 'synthetic-cancel', 0, 'failed'); await t.consume(second);
    await t.receipt(second, 'second-cancel', 0); assert.equal((await t.get(second)).state, 'confirmed');
  });
  await test('Two exact refund receipts exhaust the paid amount; one receipt cannot settle two operations', async () => {
    const t = await setup('safety-exact'), one = await t.prepare('one', 5), two = await t.prepare('two', 5);
    await Promise.all([t.consume(one), t.consume(two)]);
    await t.receipt(one, 'refund-one', 5); await t.receipt(two, 'refund-two', 5);
    assert.equal(t.dump().safetyTargets[0].refundedMinor, 10);
    await assert.rejects(t.consume(await t.prepare('third', 5)), /remaining paid/);
    const d = await setup('safety-duplicate'), first = await d.prepare('one', 5), second = await d.prepare('two', 5);
    await Promise.all([d.consume(first), d.consume(second)]);
    await d.receipt(first, 'same-receipt', 5); await d.receipt(second, 'same-receipt', 5);
    assert.equal(d.dump().safetyTargets[0].pendingRefundMinor, 5);
    assert.equal(d.dump().safetyTargets[0].anomaly, 'receiptIdentityCollision');
  });
  await test('Outside pending refunds hold headroom; an authoritative failed receipt releases only that receipt', async () => {
    const t = await setup('safety-outside');
    const r = { receiptId: 'outside', sourceRef: t.identity.providerRef, currency: 'USD', amountMinor: 5, status: 'pending' };
    await t.pull([r]); await t.pull();
    assert.equal(t.dump().safetyTargets[0].providerPendingMinor, 5);
    await assert.rejects(t.consume(await t.prepare('blocked', 6)), /remaining paid/);
    await t.pull([{ ...r, status: 'failed' }]);
    await t.consume(await t.prepare('allowed', 10));
  });
  await test('Matched pending receipt replaces its local hold; late acknowledgement cannot overwrite fetched failure', async () => {
    const t = await setup('safety-refetch'), id = await t.prepare('one'); await t.consume(id);
    await t.receipt(id, 'refetched', 6, 'pending');
    assert.deepEqual(t.dump().safetyTargets.map(x => [x.pendingRefundMinor, x.providerPendingMinor]), [[0, 6]]);
    await t.receipt(id, 'refetched', 6, 'failed');
    runtime.run('integrations/receipts:acknowledge', { id, receipt: { receiptId: 'refetched', operationId: id, sourceRef: t.identity.providerRef, currency: 'USD', amountMinor: 6, status: 'pending' } });
    assert.deepEqual(t.dump().safetyTargets.map(x => [x.pendingRefundMinor, x.providerPendingMinor, x.refundedMinor]), [[0, 0, 0]]);
    assert.equal((await t.get(id)).state, 'refused');
  });
  await test('Incomplete reconciliation blocks new safety consume and preserves unknown local holds', async () => {
    const t = await setup('safety-incomplete'), id = await t.prepare('one', 5); await t.consume(id); await pause(100);
    await t.pull([], false); await assert.rejects(t.consume(await t.prepare('two', 5)), /incomplete/);
    assert.equal(t.dump().safetyTargets[0].pendingRefundMinor, 5);
    await t.pull(); assert.equal(t.dump().safetyTargets[0].pendingRefundMinor, 5);
  });
  await test('General refund and recurring-cancel dispatch refuse the safety-ledger bypass', async () => {
    for (const capability of ['billing.refund', 'billing.cancelRecurring']) {
      const t = await tenant('generic-' + capability);
      const id = await t.propose('bypass', 1, 1, { capability, payload: { ...t.payload, amountMinor: capability === 'billing.refund' ? 5 : 0 } });
      await assert.rejects(t.permit(id), /shared financial ledger/);
    }
  });
  await test('Only capability-specific finality with a complete post-consume lookup releases an unknown refund', async () => {
    const t = await setup('safety-finality'), id = await t.prepare('one');
    const oldLookup = t.dump().safetyTargets[0].lookupId; await t.consume(id); await pause(100);
    runtime.run('integrations/connections:registerProvider', { provider: 'fake', enabled: true, finalityRules: [{ capability: 'billing.refund', semantics: 'SIM exact receipt lookup can prove final absence', proofRef: 'SIM: deterministic no-provider absence' }] });
    await assert.rejects(t.adapter('safety-resolve-unknown', { id, lookupId: oldLookup }), /after the send action/);
    const { lookupId } = await t.pull(); await t.adapter('safety-resolve-unknown', { id, lookupId }); await t.adapter('safety-resolve-unknown', { id, lookupId });
    assert.equal(t.dump().safetyTargets[0].pendingRefundMinor, 0);
    await t.receipt(id, 'late', 6); await t.receipt(id, 'late', 6);
    assert.deepEqual(t.dump().safetyTargets.map(x => [x.refundedMinor, x.pendingRefundMinor, x.anomaly]), [[6, 0, 'acceptedAfterFinalAbsence']]);
    runtime.run('integrations/connections:registerProvider', { provider: 'fake', enabled: true });
  });
}
