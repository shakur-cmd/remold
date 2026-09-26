import { internalMutation, type MutationCtx } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { financialReceipt } from '../../packages/contracts/integrations';
import { bound } from './connections';
import { epoch, principalFor } from '../authority/grants';
import { event } from './core';
import { fail } from '../errors';
import type { SafetyReceipt } from './safetyAdapters';
export async function recordReceipt(ctx: MutationCtx, target: Doc<'safetyTargets'>, receipt: SafetyReceipt, generation?: number) {
  const binding = await ctx.db.get(target.bindingId); if (!binding) fail('NOT_FOUND');
  const kind: 'refund' | 'clientRecurringCancel' = target.kind === 'payment' ? 'refund' : 'clientRecurringCancel';
  if (!receipt.receiptId || receipt.receiptId.length > 300 || receipt.sourceRef !== target.providerRef || receipt.currency !== target.currency || !Number.isSafeInteger(receipt.amountMinor) || receipt.amountMinor < 0 || (kind === 'clientRecurringCancel' && receipt.amountMinor !== 0)) fail('VALIDATION', 'Receipt target or amount mismatch');
  const prior = await ctx.db.query('integrationReceipts').withIndex('by_receipt', q => q.eq('provider', binding.provider).eq('environment', binding.environment).eq('account', binding.account).eq('kind', kind).eq('receipt.receiptId', receipt.receiptId)).unique();
  const hold = async (reason: string) => { await ctx.db.patch(target._id, { anomaly: reason }); await ctx.db.insert('integrationEvents', { orgId: target.orgId, bindingId: target.bindingId, actor: { kind: 'adapter', id: binding.connectionId }, name: reason, at: Date.now() }); return { accepted: false, error: reason }; };
  if (prior && (prior.targetId !== target._id || prior.orgId !== target.orgId || prior.receipt.sourceRef !== receipt.sourceRef || prior.receipt.currency !== receipt.currency || prior.receipt.amountMinor !== receipt.amountMinor || prior.receipt.operationId !== receipt.operationId)) return hold('receiptIdentityCollision');
  // A late create acknowledgement must never overwrite an authoritative refetch.
  if (prior && generation === undefined) return { accepted: true, duplicate: true };
  if (prior?.observedGeneration !== undefined && generation !== undefined && prior.observedGeneration >= generation) {
    if (prior.receipt.status !== receipt.status) return hold('receiptChangedWithinTraversal');
    return { accepted: true, duplicate: true };
  }
  const succeeded = (r?: SafetyReceipt) => kind === 'refund' && r?.status === 'succeeded' ? r.amountMinor : 0;
  const pending = (r?: SafetyReceipt) => kind === 'refund' && r?.status === 'pending' ? r.amountMinor : 0;
  const refundedMinor = target.refundedMinor + succeeded(receipt) - succeeded(prior?.receipt), providerPendingMinor = target.providerPendingMinor + pending(receipt) - pending(prior?.receipt);
  const row = { orgId: target.orgId, targetId: target._id, provider: binding.provider, environment: binding.environment, account: binding.account, kind, receipt, observedGeneration: generation };
  const receiptId = prior?._id ?? await ctx.db.insert('integrationReceipts', row);
  if (prior) await ctx.db.patch(prior._id, row);
  await ctx.db.patch(target._id, { refundedMinor, providerPendingMinor, ...(kind === 'clientRecurringCancel' && receipt.status === 'succeeded' ? { cancelled: true } : {}) });
  const operationId = receipt.operationId ? ctx.db.normalizeId('integrationOps', receipt.operationId) : null, op = operationId ? await ctx.db.get(operationId) : null;
  if (op) {
    if (op.orgId !== target.orgId || op.bindingId !== binding._id || op.safety?.targetId !== target._id || op.safety.amountMinor !== receipt.amountMinor || !op.permitUsed) return hold('receiptOperationMismatch');
    if (op.safety.receiptId && op.safety.receiptId !== receiptId) return hold('multipleReceiptsForOperation');
    let late = op.cancelRequestedAt !== undefined || op.absence?.finality === 'final';
    try { const human = await principalFor(ctx, op.orgId, op.actor); if (!('member' in human) || human.member._id !== op.actorMembershipId || epoch(human) !== op.actorEpoch) late = true; } catch { late = true; }
    if (op.safety.reservationActive) await ctx.db.patch(target._id, kind === 'refund' ? { pendingRefundMinor: target.pendingRefundMinor - op.safety.amountMinor } : { pendingCancel: undefined });
    await ctx.db.patch(receiptId, { boundOperationId: op._id });
    await ctx.db.patch(op._id, { state: ['failed', 'cancelled'].includes(receipt.status) ? 'refused' : 'confirmed', providerRef: receipt.receiptId, receipts: [{ step: 1, providerRef: receipt.receiptId, usage: 0, late, at: op.receipts[0]?.at ?? Date.now() }], safety: { ...op.safety, receiptId, reservationActive: false }, released: true, late });
    await event(ctx, op, 'safetyReceipt:' + receipt.status, { kind: 'adapter', id: binding.connectionId });
    if (op.absence?.finality === 'final') return hold('acceptedAfterFinalAbsence');
  }
  const current = (await ctx.db.get(target._id))!;
  if (current.refundedMinor + current.providerPendingMinor + current.pendingRefundMinor > current.paidMinor) return hold('refundExposureExceeded');
  return { accepted: true };
}
export const observe = internalMutation({ args: { credentialHash: v.string(), targetId: v.id('safetyTargets'), generation: v.number(), receipt: financialReceipt }, handler: async (ctx, args) => {
  const target = await ctx.db.get(args.targetId); if (!target) fail('NOT_FOUND'); await bound(ctx, args.credentialHash, target.bindingId);
  if (target.generation !== args.generation || target.complete) fail('CONFLICT', 'Stale or completed reconciliation generation');
  return recordReceipt(ctx, target, args.receipt, args.generation);
} });
export const acknowledge = internalMutation({ args: { id: v.id('integrationOps'), receipt: financialReceipt }, handler: async (ctx, args) => {
  const op = await ctx.db.get(args.id), target = op?.safety ? await ctx.db.get(op.safety.targetId) : null;
  if (!op || !target || args.receipt.operationId !== op._id) fail('FORBIDDEN', 'Receipt must name its exact operation');
  return recordReceipt(ctx, target, args.receipt);
} });
