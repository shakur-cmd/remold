import { mutation, internalMutation, internalQuery, internalAction } from '../_generated/server';
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { requireMember } from '../identity';
import { epoch } from '../authority/grants';
import { fail } from '../errors';
import { bound, usable } from './connections';
import { approveBindingRead, event, ownOp, sameActor } from './core';
import { safetyAdapter, type SafetyCapability, type SafetyRequest } from './safetyAdapters';
const kind = v.union(v.literal('refund'), v.literal('cancelRecurring'));
// I7's authenticated provider adapter supplies these authoritative payment facts.
// This seam does not create invoices, subscriptions, charges, or customer consent.
export const beginTarget = internalMutation({ args: { credentialHash: v.string(), bindingId: v.id('integrationBindings'), documentRef: v.string(), providerRef: v.string(), kind: v.union(v.literal('payment'), v.literal('clientRecurring')), currency: v.string(), paidMinor: v.number() }, handler: async (ctx, args) => {
  const { binding } = await bound(ctx, args.credentialHash, args.bindingId);
  if (!args.documentRef || !args.providerRef || !/^[A-Z]{3}$/.test(args.currency) || !Number.isSafeInteger(args.paidMinor) || args.paidMinor < 0) fail('VALIDATION');
  const prior = await ctx.db.query('safetyTargets').withIndex('by_binding', q => q.eq('bindingId', binding._id)).unique();
  if (prior && (prior.documentRef !== args.documentRef || prior.providerRef !== args.providerRef || prior.kind !== args.kind || prior.currency !== args.currency)) fail('CONFLICT', 'Payment identity changed');
  if (prior) { await ctx.db.patch(prior._id, { generation: prior.generation + 1, startedAt: Date.now(), complete: false, paidMinor: args.paidMinor }); return { targetId: prior._id, generation: prior.generation + 1 }; }
  const { credentialHash: _credentialHash, ...identity } = args;
  const targetId = await ctx.db.insert('safetyTargets', { ...identity, orgId: binding.orgId, refundedMinor: 0, pendingRefundMinor: 0, providerPendingMinor: 0, cancelled: false, generation: 1, startedAt: Date.now(), complete: false }); return { targetId, generation: 1 };
} });
export const completeTarget = internalMutation({ args: { credentialHash: v.string(), targetId: v.id('safetyTargets'), generation: v.number(), paidMinor: v.number(), cancelled: v.boolean(), lookupId: v.id('integrationLookups') }, handler: async (ctx, args) => {
  const target = await ctx.db.get(args.targetId); if (!target) fail('NOT_FOUND'); const { connection } = await bound(ctx, args.credentialHash, target.bindingId);
  const lookup = await ctx.db.get(args.lookupId);
  if (target.generation !== args.generation || !lookup || lookup.connectionId !== connection._id || lookup.resource !== 'financial:' + target._id + ':' + args.generation || !Number.isSafeInteger(args.paidMinor) || args.paidMinor < 0) fail('CONFLICT', 'Incomplete or stale authoritative lookup');
  await ctx.db.patch(target._id, { paidMinor: args.paidMinor, cancelled: args.cancelled, complete: true, lookupId: args.lookupId });
} });
export const prepare = mutation({ args: { orgId: v.id('orgs'), targetId: v.id('safetyTargets'), logical: v.string(), kind, amountMinor: v.number() }, handler: async (ctx, args) => {
  const human = await requireMember(ctx, args.orgId, 'admin'), target = await ctx.db.get(args.targetId);
  if (!target || target.orgId !== args.orgId) fail('NOT_FOUND');
  if (!args.logical || args.logical.length > 200 || !Number.isSafeInteger(args.amountMinor) || (args.kind === 'refund' ? args.amountMinor <= 0 || target.kind !== 'payment' : args.amountMinor !== 0 || target.kind !== 'clientRecurring')) fail('VALIDATION', 'Invalid safety command');
  const binding = await ctx.db.get(target.bindingId); if (!binding || binding.orgId !== args.orgId) fail('NOT_FOUND'); await approveBindingRead(ctx, human, binding);
  const prior = await ctx.db.query('integrationOps').withIndex('by_logical', q => q.eq('orgId', args.orgId).eq('actor.id', human.actor.id).eq('logical', args.logical)).unique();
  if (prior) { if (prior.safety?.targetId !== target._id || prior.safety.kind !== args.kind || prior.safety.amountMinor !== args.amountMinor) fail('CONFLICT'); return prior._id; }
  const capability = args.kind === 'refund' ? 'billing.refund' : 'billing.cancelRecurring';
  const payload = { content: '', audience: [], audienceVersion: 0, destination: binding.account, schedule: 0, amountMinor: args.amountMinor, currency: target.currency, workflowVersion: 1 };
  const id = await ctx.db.insert('integrationOps', { orgId: args.orgId, actor: human.actor, owner: human.actor, author: human.actor, actorEpoch: epoch(human), actorMembershipId: human.member._id, capability, logical: args.logical, bindingId: binding._id, payload, version: 1, state: 'approved', approval: { snapshot: payload, version: 1, actorEpoch: epoch(human), approver: human.actor, approverEpoch: epoch(human), approverMembershipId: human.member._id, expiresAt: Date.now() + 60000 }, safety: { targetId: target._id, documentRef: target.documentRef, kind: args.kind, amountMinor: args.amountMinor, reservationActive: false }, reservationUnits: 0, reserved: 0, usage: 0, usageMissing: false, step: 1, maxSteps: 1, fence: 0, leaseUntil: 0, permitUntil: 0, permitUsed: false, attempts: 0, released: false, overrun: false, late: false, consumedPermits: [], receipts: [] });
  await event(ctx, (await ctx.db.get(id))!, 'safetyApproved', human.actor); return id;
} });
export const consume = mutation({ args: { orgId: v.id('orgs'), id: v.id('integrationOps') }, handler: async (ctx, args) => {
  // Convex verifies the current caller JWT; external session revocation is bounded
  // by that JWT's lifetime. Membership/epoch changes take effect in this transaction.
  const human = await requireMember(ctx, args.orgId, 'admin'), op = await ownOp(ctx, human, args.id), safety = op.safety;
  if (!safety || op.actor.kind !== 'user' || !sameActor(op.actor, human.actor) || op.actorMembershipId !== human.member._id || op.actorEpoch !== epoch(human)) fail('FORBIDDEN', 'Human safety authority changed');
  if (op.permitUsed) return { consumed: true, duplicate: true };
  if (op.state !== 'approved' || op.cancelRequestedAt !== undefined || !op.approval || op.approval.expiresAt <= Date.now()) fail('FORBIDDEN', 'Safety approval expired or stopped');
  const target = await ctx.db.get(safety.targetId), binding = await ctx.db.get(op.bindingId), connection = binding ? await ctx.db.get(binding.connectionId) : null;
  if (!target || !binding?.connected || !connection || target.orgId !== args.orgId || target.bindingId !== binding._id || target.documentRef !== safety.documentRef || binding.orgId !== args.orgId || connection.orgId !== args.orgId || op.payload.destination !== binding.account || target.currency !== op.payload.currency) fail('FORBIDDEN', 'Safety target changed');
  await approveBindingRead(ctx, human, binding); await usable(ctx, connection);
  if (!target.complete) fail('FORBIDDEN', 'Payment reconciliation incomplete');
  if (target.anomaly) fail('FORBIDDEN', 'Payment anomaly requires reconciliation');
  const selected = safetyAdapter(binding.provider, op.capability as SafetyCapability);
  if (!selected?.proofRef) fail('UNSUPPORTED', 'Selected safety adapter is not implemented');
  if (safety.kind === 'refund') {
    if (op.capability !== 'billing.refund' || target.kind !== 'payment' || safety.amountMinor <= 0 || safety.amountMinor > target.paidMinor - target.refundedMinor - target.providerPendingMinor - target.pendingRefundMinor) fail('FORBIDDEN', 'Refund exceeds remaining paid amount');
    await ctx.db.patch(target._id, { pendingRefundMinor: target.pendingRefundMinor + safety.amountMinor });
  } else {
    const pendingReceipt = await ctx.db.query('integrationReceipts').withIndex('by_target', q => q.eq('targetId', target._id)).filter(q => q.eq(q.field('receipt.status'), 'pending')).first();
    if (op.capability !== 'billing.cancelRecurring' || target.kind !== 'clientRecurring' || target.cancelled || target.pendingCancel || pendingReceipt || safety.amountMinor !== 0) fail('FORBIDDEN', 'Recurring cancellation unavailable');
    await ctx.db.patch(target._id, { pendingCancel: op._id });
  }
  await ctx.db.patch(op._id, { safety: { ...safety, reservationActive: true, consumedAt: Date.now() }, state: 'dispatching', fence: 1, step: 1, permitUsed: true, consumedPermits: [{ fence: 1, step: 1 }], attempts: 1 });
  await event(ctx, op, 'readonly.safety.consumed', human.actor);
  await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('integrations/safety:send'), { id: op._id });
  await ctx.scheduler.runAfter(2000, makeFunctionReference<'mutation'>('integrations/safety:unknown'), { id: op._id });
  return { consumed: true, duplicate: false };
} });
export const request = internalQuery({ args: { id: v.id('integrationOps') }, handler: async (ctx, args) => {
  const op = await ctx.db.get(args.id);
  if (!op?.safety || !op.permitUsed || !['dispatching', 'cancellationPending', 'outcomeUnknown'].includes(op.state)) return null;
  const target = await ctx.db.get(op.safety.targetId), binding = await ctx.db.get(op.bindingId), connection = binding ? await ctx.db.get(binding.connectionId) : null;
  const ref = connection ? await ctx.db.get(connection.secretReferenceId) : null;
  if (!target || !binding || !connection || !ref) return null;
  return { provider: binding.provider, operationId: op._id, key: op._id + ':step:1', capability: op.capability as SafetyCapability, account: binding.account, environment: binding.environment, providerRef: target.providerRef, amountMinor: op.safety.amountMinor, currency: target.currency, secretHandle: ref.handle } satisfies SafetyRequest & { provider: string };
} });
export const send = internalAction({ args: { id: v.id('integrationOps') }, handler: async (ctx, args) => {
  const request = await ctx.runQuery(makeFunctionReference<'query'>('integrations/safety:request'), args) as (SafetyRequest & { provider: string }) | null;
  if (!request) return;
  const selected = safetyAdapter(request.provider, request.capability);
  try {
    if (!selected) throw new Error('Adapter unavailable');
    const receipt = await selected.dispatch(ctx, request);
    await ctx.runMutation(makeFunctionReference<'mutation'>('integrations/receipts:acknowledge'), { id: args.id, receipt });
  } catch {
    // A transport failure after final consume is not proof of no refund/cancel.
    await ctx.runMutation(makeFunctionReference<'mutation'>('integrations/safety:unknown'), args);
  } finally {
    await ctx.runMutation(makeFunctionReference<'mutation'>('integrations/safety:sendSettled'), args);
  }
} });
export const unknown = internalMutation({ args: { id: v.id('integrationOps') }, handler: async (ctx, args) => {
  const op = await ctx.db.get(args.id); if (!op?.safety || !op.permitUsed || op.receipts.length || op.absence?.finality === 'final' || !['dispatching', 'cancellationPending'].includes(op.state)) return;
  await ctx.db.patch(op._id, { state: 'outcomeUnknown' }); await event(ctx, op, 'safetyOutcomeUnknown', { kind: 'scheduler', id: 'safety-adapter' });
} });
export const sendSettled = internalMutation({ args: { id: v.id('integrationOps') }, handler: async (ctx, args) => {
  const op = await ctx.db.get(args.id); if (!op?.safety || !op.permitUsed || op.safety.sendSettledAt !== undefined) return;
  await ctx.db.patch(op._id, { safety: { ...op.safety, sendSettledAt: Date.now() } });
} });
