import { expect, it, vi } from 'vitest';
import { anyApi } from 'convex/server';
import { api, userAndOrg } from '../../convex/test.helpers';
const finality = vi.hoisted(() => ({ accepts: true }));
// This test adapter never contacts a provider. SERVICE tests preserve the same label.
vi.mock('../../convex/integrations/safetyAdapters', () => ({ safetyAdapter: (provider: string) => provider === 'fake' ? { proofRef: 'SIM: unknown outcome adapter', finality: { proofRef: 'SIM: deterministic no-provider absence', verifyAbsent: async () => finality.accepts }, dispatch: async () => { throw new Error('SIM unknown'); } } : undefined }));
const safety = anyApi['integrations/safety'], commands = anyApi['integrations/commands'];
async function fixture(kind: 'payment' | 'clientRecurring' = 'payment') {
  const f = await userAndOrg(), credentialHash = 'a'.repeat(64);
  await f.t.mutation(anyApi['integrations/connections'].registerProvider, { provider: 'fake', enabled: true });
  const secretReferenceId = await f.t.mutation(anyApi['integrations/connections'].registerSecret, { orgId: f.orgId, provider: 'fake', environment: 'test', account: 'A', handle: 'vault:00000000-0000-0000-0000-000000000001' });
  const connectionId = await f.client.mutation(anyApi['integrations/connections'].insert, { orgId: f.orgId, secretReferenceId, credentialHash });
  const bindingId = await f.t.run(ctx => ctx.db.insert('integrationBindings', { orgId: f.orgId, connectionId, provider: 'fake', environment: 'test', account: 'A', kind, externalId: 'source-A', connected: true }));
  const pull = async (receipts: any[] = [], complete = true) => {
    const started = await f.t.mutation(safety.beginTarget, { credentialHash, bindingId, documentRef: 'document-A', providerRef: 'source-A', kind, currency: 'USD', paidMinor: 10 });
    for (const receipt of receipts) await f.t.mutation(anyApi['integrations/receipts'].observe, { credentialHash, ...started, receipt });
    if (complete) {
      const resource = `financial:${started.targetId}:${started.generation}`;
      await f.t.mutation(anyApi['integrations/callbacks'].page, { credentialHash, resource, traversal: 'generation-' + started.generation, from: 0, page: 1, items: [], end: true, checkpoint: started.generation });
      const lookupId = await f.t.action(anyApi['integrations/lookups'].seal, { credentialHash, resource });
      await f.t.mutation(safety.completeTarget, { credentialHash, ...started, paidMinor: 10, cancelled: false, lookupId });
    }
    return started;
  };
  const { targetId } = await pull();
  const ack = (id: any, receiptId: string, amountMinor: number, status = 'succeeded') => f.t.mutation(anyApi['integrations/receipts'].acknowledge, { id, receipt: { receiptId, operationId: id, sourceRef: 'source-A', currency: 'USD', amountMinor, status } });
  await f.t.run(ctx => ctx.db.patch(f.orgId, { flags: { readonly: true } }));
  const prepare = (logical: string, amountMinor = 6) => f.client.mutation(safety.prepare, { orgId: f.orgId, targetId, logical, kind: kind === 'payment' ? 'refund' : 'cancelRecurring', amountMinor });
  const consume = (id: any) => f.client.mutation(safety.consume, { orgId: f.orgId, id });
  const target = () => f.t.run(ctx => ctx.db.get(targetId));
  return { ...f, credentialHash, targetId, bindingId, connectionId, prepare, consume, target, pull, ack };
}
it('readonly human safety uses paid-minus-refunded-minus-pending and deduplicates both consume and receipt', async () => {
  const f = await fixture(), id = await f.prepare('refund');
  await f.consume(id); expect(await f.consume(id)).toMatchObject({ duplicate: true });
  await expect(f.consume(await f.prepare('excess'))).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  expect(await f.target()).toMatchObject({ pendingRefundMinor: 6, refundedMinor: 0 });
  await f.ack(id, 'refund-1', 6);
  await f.ack(id, 'refund-1', 6);
  expect(await f.target()).toMatchObject({ pendingRefundMinor: 0, refundedMinor: 6 });
  await expect(f.consume(await f.prepare('too-much', 5))).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
});
it('membership change before final safety consume refuses without reserving money', async () => {
  const f = await fixture(), id = await f.prepare('epoch');
  await f.t.run(async ctx => { const member = await ctx.db.query('members').withIndex('by_org_user', q => q.eq('orgId', f.orgId)).first(); await ctx.db.patch(member!._id, { authorityEpoch: 1 }); });
  await expect(f.consume(id)).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } }); expect((await f.target())?.pendingRefundMinor).toBe(0);
});
it('ordinary dispatch cannot borrow a safety approval and agents cannot call human safety', async () => {
  const f = await fixture(), id = await f.prepare('human');
  await expect(f.client.mutation(commands.claimHuman, { orgId: f.orgId, id, worker: 'agent' })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await expect(f.t.mutation(safety.consume, { orgId: f.orgId, id })).rejects.toMatchObject({ data: { code: 'UNAUTHENTICATED' } });
  await expect(f.client.mutation(safety.prepare, { orgId: f.orgId, targetId: f.targetId, logical: 'charge', kind: 'charge', amountMinor: 1 })).rejects.toThrow();
  expect((await f.target())?.pendingRefundMinor).toBe(0);
});
it('client recurring cancellation is zero amount and cannot masquerade as refund or charge', async () => {
  const f = await fixture('clientRecurring');
  await expect(f.prepare('amount', 1)).rejects.toMatchObject({ data: { code: 'VALIDATION' } });
  const id = await f.prepare('cancel', 0); await f.consume(id);
  expect((await f.client.query(commands.getHuman, { orgId: f.orgId, id })).capability).toBe('billing.cancelRecurring');
  await f.ack(id, 'cancel-1', 0); expect((await f.target())?.cancelled).toBe(true);
});
it('unknown refund headroom cannot be released by an owner or an unproven finality claim', async () => {
  const f = await fixture(), id = await f.prepare('unknown'); await f.consume(id); await f.t.mutation(safety.unknown, { id });
  await expect(f.client.mutation(anyApi['integrations/outcomes'].operatorResolveUnknown, { orgId: f.orgId, id, fence: 1, step: 1, finality: 'final', evidence: 'owner thinks absent' })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await expect(f.t.action(anyApi['integrations/safetyFinality'].resolve, { credentialHash: f.credentialHash, id, lookupId: (await f.target())!.lookupId })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  expect((await f.target())?.pendingRefundMinor).toBe(6);
  await f.t.mutation(anyApi['integrations/connections'].registerProvider, { provider: 'fake', enabled: true, finalityRules: [{ capability: 'billing.cancelRecurring', semantics: 'SIM final cancel proof', proofRef: 'SIM: cancel-only' }] });
  await expect(f.t.action(anyApi['integrations/safetyFinality'].resolve, { credentialHash: f.credentialHash, id, lookupId: (await f.target())!.lookupId })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await f.t.mutation(anyApi['integrations/connections'].registerProvider, { provider: 'fake', enabled: true, finalityRules: [{ capability: 'billing.refund', semantics: 'SIM final refund proof', proofRef: 'SIM: deterministic no-provider absence' }] });
  await f.t.mutation(safety.sendSettled, { id });
  await new Promise(resolve => setTimeout(resolve, 2));
  await f.pull();
  await f.t.action(anyApi['integrations/safetyFinality'].resolve, { credentialHash: f.credentialHash, id, lookupId: (await f.target())!.lookupId });
  expect((await f.target())?.pendingRefundMinor).toBe(0);
  await f.ack(id, 'unexpected', 6);
  expect(await f.target()).toMatchObject({ pendingRefundMinor: 0, refundedMinor: 6, anomaly: 'acceptedAfterFinalAbsence' });
});
it('two exact 5 refunds cannot settle from one aggregate of 5 and free more paid headroom', async () => {
  const f = await fixture(), one = await f.prepare('one', 5), two = await f.prepare('two', 5); await f.consume(one); await f.consume(two);
  await f.ack(one, 'refund-1', 5);
  await f.ack(two, 'refund-2', 5);
  await expect(f.consume(await f.prepare('third', 5))).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
});
it('one provider receipt cannot settle a second operation', async () => {
  const f = await fixture(), one = await f.prepare('one', 5), two = await f.prepare('two', 5); await f.consume(one); await f.consume(two);
  await f.ack(one, 'same-refund', 5);
  const result = await f.ack(two, 'same-refund', 5);
  expect(result).toMatchObject({ accepted: false }); expect((await f.target())?.pendingRefundMinor).toBe(5);
});
it('the general operation path cannot dispatch a refund outside the shared safety headroom', async () => {
  const f = await fixture(); await f.t.run(ctx => ctx.db.patch(f.orgId, { flags: { readonly: false } }));
  for (const orgId of [undefined, f.orgId]) await f.t.mutation(anyApi['integrations/budgets'].configure, { ...(orgId ? { orgId } : {}), cap: 10, maxConcurrent: 3, maxPerRun: 10, maxSteps: 3, maxRecipients: 10 });
  const id = await f.client.mutation(commands.proposeHuman, { orgId: f.orgId, logical: 'generic-refund', bindingId: f.bindingId, capability: 'billing.refund', payload: { content: '', audience: [], audienceVersion: 0, destination: 'A', schedule: 0, amountMinor: 5, currency: 'USD', workflowVersion: 1 }, reservationUnits: 1, maxSteps: 1 });
  await f.client.mutation(commands.approve, { orgId: f.orgId, id, expiresAt: Date.now() + 60000 });
  const claim = await f.client.mutation(commands.claimHuman, { orgId: f.orgId, id, worker: 'generic' });
  await expect(f.t.mutation(anyApi['integrations/dispatch'].permit, { credentialHash: f.credentialHash, id, ...claim, worker: 'generic' })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
});
it('outside pending refunds consume headroom and only authoritative refetch can reverse their status', async () => {
  const f = await fixture();
  const outside = { receiptId: 'outside-refund', sourceRef: 'source-A', currency: 'USD', amountMinor: 5, status: 'pending' };
  await f.pull([outside]); expect(await f.target()).toMatchObject({ providerPendingMinor: 5, refundedMinor: 0 });
  await expect(f.consume(await f.prepare('denied', 6))).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await f.pull([{ ...outside, status: 'failed' }]); expect(await f.target()).toMatchObject({ providerPendingMinor: 0, refundedMinor: 0 });
  await f.consume(await f.prepare('allowed', 10));
});
it('callback-first exact receipt and late create acknowledgement never resurrect a failed refund', async () => {
  const f = await fixture(), id = await f.prepare('refund'); await f.consume(id);
  const receipt = { receiptId: 'refetched', sourceRef: 'source-A', currency: 'USD', amountMinor: 6, operationId: id, status: 'pending' };
  await f.pull([receipt]); expect(await f.target()).toMatchObject({ pendingRefundMinor: 0, providerPendingMinor: 6 });
  await f.pull([{ ...receipt, status: 'failed' }]); await f.ack(id, 'refetched', 6, 'pending');
  expect(await f.target()).toMatchObject({ pendingRefundMinor: 0, providerPendingMinor: 0, refundedMinor: 0 });
  expect((await f.client.query(commands.getHuman, { orgId: f.orgId, id })).state).toBe('refused');
});
it('incomplete reconciliation keeps unknown local holds and blocks new permits', async () => {
  const f = await fixture(), id = await f.prepare('first', 5); await f.consume(id); await f.t.mutation(safety.unknown, { id });
  await f.pull([], false); expect(await f.target()).toMatchObject({ complete: false, pendingRefundMinor: 5 });
  await expect(f.consume(await f.prepare('second', 5))).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await f.pull(); expect((await f.target())?.pendingRefundMinor).toBe(5);
});
it('a mismatched operation amount records outside truth without releasing the local hold', async () => {
  const f = await fixture(), id = await f.prepare('six'); await f.consume(id);
  expect(await f.ack(id, 'wrong-amount', 5)).toMatchObject({ accepted: false });
  expect(await f.target()).toMatchObject({ pendingRefundMinor: 6, refundedMinor: 5, anomaly: 'receiptOperationMismatch' });
});

it('local send settlement plus operator rules cannot replace the code-owned provider finality check', async () => {
  const f = await fixture(), id = await f.prepare('provider-refuses'); await f.consume(id);
  await f.t.mutation(safety.unknown, { id }); await f.t.mutation(safety.sendSettled, { id });
  await f.t.mutation(anyApi['integrations/connections'].registerProvider, { provider: 'fake', enabled: true, finalityRules: [{ capability: 'billing.refund', semantics: 'SIM provider-specific proof', proofRef: 'SIM: deterministic no-provider absence' }] });
  await new Promise(resolve => setTimeout(resolve, 2)); await f.pull();
  finality.accepts = false;
  try { await expect(f.t.action(anyApi['integrations/safetyFinality'].resolve, { credentialHash: f.credentialHash, id, lookupId: (await f.target())!.lookupId })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } }); }
  finally { finality.accepts = true; }
  expect((await f.target())?.pendingRefundMinor).toBe(6);
  await f.t.action(anyApi['integrations/safetyFinality'].resolve, { credentialHash: f.credentialHash, id, lookupId: (await f.target())!.lookupId });
  expect((await f.target())?.pendingRefundMinor).toBe(0);
});
it('a pending recurring cancellation blocks a second command until an authoritative terminal receipt', async () => {
  const f = await fixture('clientRecurring'), one = await f.prepare('one', 0); await f.consume(one);
  const receipt = { receiptId: 'cancel-pending', operationId: one, sourceRef: 'source-A', currency: 'USD', amountMinor: 0, status: 'pending' };
  await f.pull([receipt]);
  const two = await f.prepare('two', 0);
  await expect.soft(f.consume(two)).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await f.pull([{ ...receipt, status: 'failed' }]);
  await f.consume(two);
});
