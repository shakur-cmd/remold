import { internalAction, internalMutation, internalQuery, type QueryCtx, type MutationCtx } from '../_generated/server';
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import { bound } from './connections';
import { safetyAdapter, type SafetyCapability, type SafetyLookup, type SafetyRequest } from './safetyAdapters';
import { event } from './core';
import { fail } from '../errors';
const args = { credentialHash: v.string(), id: v.id('integrationOps'), lookupId: v.id('integrationLookups') };
type Input = { credentialHash: string; id: Id<'integrationOps'>; lookupId: Id<'integrationLookups'> };
async function eligible(ctx: QueryCtx | MutationCtx, input: Input) {
  const op = await ctx.db.get(input.id); if (!op?.safety || !op.permitUsed || op.receipts.length) fail('FORBIDDEN');
  const { binding, connection } = await bound(ctx, input.credentialHash, op.bindingId);
  const selected = safetyAdapter(binding.provider, op.capability as SafetyCapability)?.finality;
  const provider = await ctx.db.query('integrationProviders').withIndex('by_provider', q => q.eq('provider', binding.provider)).unique();
  if (!selected?.proofRef || !provider?.finalityRules.some(r => r.capability === op.capability && r.proofRef === selected.proofRef)) fail('FORBIDDEN', 'Authoritative provider finality lookup implementation required');
  const target = await ctx.db.get(op.safety.targetId), lookup = await ctx.db.get(input.lookupId);
  if (op.absence?.finality === 'final') return { op, duplicate: true as const };
  if (op.state !== 'outcomeUnknown' || !target?.complete || target.lookupId !== input.lookupId || !lookup || lookup.connectionId !== connection._id || lookup.resource !== 'financial:' + target._id + ':' + target.generation) fail('FORBIDDEN', 'Complete current authoritative lookup required');
  // Local settlement is only a lower time bound; provider finality is checked by
  // the registered adapter method, never inferred from a timeout or elapsed time.
  if (op.safety.sendSettledAt === undefined || target.startedAt <= op.safety.sendSettledAt) fail('FORBIDDEN', 'Lookup must start after the send action exits');
  const ref = await ctx.db.get(connection.secretReferenceId); if (!ref) fail('NOT_FOUND');
  const request: SafetyRequest = { operationId: op._id, key: op._id + ':step:1', capability: op.capability as SafetyCapability, account: binding.account, environment: binding.environment, providerRef: target.providerRef, amountMinor: op.safety.amountMinor, currency: target.currency, secretHandle: ref.handle };
  const proof: SafetyLookup = { lookupId: lookup._id, generation: target.generation, traversal: lookup.traversal, pageCount: lookup.pageCount, digest: lookup.digest, startedAt: target.startedAt, completedAt: lookup.completedAt };
  return { duplicate: false as const, op, target, connection, provider: binding.provider, proofRef: selected.proofRef, request, proof, sendSettledAt: op.safety.sendSettledAt };
}
export const inspect = internalQuery({ args, handler: eligible });
export const resolve = internalAction({ args, handler: async (ctx, input): Promise<{ duplicate: boolean }> => {
  const checked = await ctx.runQuery(makeFunctionReference<'query'>('integrations/safetyFinality:inspect'), input) as Awaited<ReturnType<typeof eligible>>;
  if (checked.duplicate) return { duplicate: true };
  const selected = safetyAdapter(checked.provider, checked.request.capability)?.finality;
  if (!selected || selected.proofRef !== checked.proofRef || !await selected.verifyAbsent(ctx, checked.request, checked.proof)) fail('FORBIDDEN', 'Provider did not prove definitive absence');
  return ctx.runMutation(makeFunctionReference<'mutation'>('integrations/safetyFinality:settle'), { ...input, generation: checked.proof.generation, sendSettledAt: checked.sendSettledAt, proofRef: checked.proofRef });
} });
export const settle = internalMutation({ args: { ...args, generation: v.number(), sendSettledAt: v.number(), proofRef: v.string() }, handler: async (ctx, input) => {
  const checked = await eligible(ctx, input); if (checked.duplicate) return { duplicate: true };
  const { op, target, connection } = checked;
  if (checked.proof.generation !== input.generation || checked.sendSettledAt !== input.sendSettledAt || checked.proofRef !== input.proofRef) fail('CONFLICT', 'Finality changed while verifying');
  const safety = op.safety!;
  if (safety.reservationActive) await ctx.db.patch(target._id, safety.kind === 'refund' ? { pendingRefundMinor: target.pendingRefundMinor - safety.amountMinor } : { pendingCancel: undefined });
  await ctx.db.patch(op._id, { state: op.cancelRequestedAt === undefined ? 'refused' : 'cancelled', released: true, safety: { ...safety, reservationActive: false }, absence: { finality: 'final', by: connection._id, at: Date.now(), evidence: checked.proofRef, lookupId: input.lookupId } });
  await event(ctx, op, 'safetyAuthoritativeAbsence', { kind: 'adapter', id: connection._id });
  return { duplicate: false };
} });
