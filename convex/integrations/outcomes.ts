import { internalMutation, mutation, type MutationCtx } from '../_generated/server';
import { v } from 'convex/values';
import { fail as deny } from '../errors';
import { requireMember } from '../identity';
import { principalFor, epoch } from '../authority/grants';
import { adapterOp, anomaly, authority, budgets, checked, event, LIMITS, ownOp, release, unresolved, type Operation } from './core';
const target = { credentialHash: v.string(), id: v.id('integrationOps'), fence: v.number(), step: v.number() };
export const unknown = internalMutation({ args: target, handler: async (ctx, args) => {
  const op = await adapterOp(ctx, args.credentialHash, args.id);
  if (op.fence !== args.fence || op.step !== args.step || !['dispatching', 'cancellationPending', 'outcomeUnknown'].includes(op.state)) deny('FORBIDDEN', 'Stale outcome');
  if (op.state === 'outcomeUnknown' || !op.permitUsed) return;
  await ctx.db.patch(op._id, { state: 'outcomeUnknown' }); await event(ctx, op, 'outcomeUnknown', { kind: 'adapter', id: op.bindingId });
} });
async function missingUsage(ctx: MutationCtx, before: Operation) {
  const op = (await ctx.db.get(before._id))!, missing = op.receipts.some(r => r.usage === undefined);
  if (missing === before.usageMissing) return;
  const { org, global } = await budgets(ctx, op.orgId);
  for (const budget of [org, global]) {
    const count = budget.missingUsageCount + (missing ? 1 : -1);
    await ctx.db.patch(budget._id, { missingUsageCount: count, missingUsage: count > 0 });
  }
  await ctx.db.patch(op._id, { usageMissing: missing });
}
export const reconcile = internalMutation({ args: { ...target, providerRef: v.string(), usage: v.optional(v.number()), continue: v.optional(v.boolean()) }, handler: async (ctx, args) => {
  const op = await adapterOp(ctx, args.credentialHash, args.id);
  if (!op.consumedPermits.some(p => p.fence === args.fence && p.step === args.step)) deny('FORBIDDEN', 'Unpermitted outcome');
  if (!args.providerRef || args.providerRef.length > 300 || (args.usage !== undefined && (!Number.isSafeInteger(args.usage) || args.usage < 0))) deny('VALIDATION', 'Invalid authoritative receipt');
  const existing = op.receipts.find(r => r.step === args.step);
  if (existing && existing.providerRef !== args.providerRef) {
    await anomaly(ctx, op, 'providerResultCollision'); return { accepted: false, error: 'providerResultCollision' };
  }
  if (existing && (existing.usage !== undefined || args.usage === undefined)) return { accepted: true, duplicate: true };
  const continuing = !!args.continue && ['dispatching', 'cancellationPending', 'outcomeUnknown'].includes(op.state) && op.step === args.step && args.usage !== undefined && op.capability === 'model.call' && op.step < op.maxSteps;
  let revoked = false;
  try { const principal = await principalFor(ctx, op.orgId, op.actor); if (epoch(principal) !== op.actorEpoch || ('member' in principal && principal.member._id !== op.actorMembershipId)) revoked = true; else await authority(ctx, principal, op); } catch { revoked = true; }
  const cancelled = op.cancelRequestedAt !== undefined, late = revoked || cancelled || !!op.absence || op.released || op.late;
  const receipt = { step: args.step, providerRef: args.providerRef, usage: args.usage, late, at: existing?.at ?? Date.now() };
  const receipts = existing ? op.receipts.map(r => r.step === args.step ? receipt : r) : [...op.receipts, receipt];
  const actual = args.usage ?? 0, total = op.usage + actual, overrun = total > op.reserved;
  if (args.usage !== undefined) {
    const { org, global } = await budgets(ctx, op.orgId), spentReservation = op.released ? 0 : Math.min(actual, Math.max(0, op.reserved - op.usage));
    for (const budget of [org, global]) await ctx.db.patch(budget._id, { spent: budget.spent + actual, reserved: budget.reserved - spentReservation });
  }
  await ctx.db.patch(op._id, { receipts, usage: total, providerRef: args.providerRef, late, overrun: op.overrun || overrun });
  if (op.released && !existing) await anomaly(ctx, op, op.absence?.finality === 'final' ? 'acceptedAfterFinalAbsence' : 'acceptedAfterRelease');
  if (overrun) {
    await anomaly(ctx, op, 'usageOverrun');
    await ctx.db.patch(op._id, { state: continuing ? 'paused' : 'confirmed', cancelRequestedAt: op.cancelRequestedAt ?? Date.now() }); await release(ctx, op);
  } else if (continuing && total < op.reserved && !revoked && !cancelled && !op.released) {
    await ctx.db.patch(op._id, { state: 'queued', step: op.step + 1, fence: op.fence + 1, worker: undefined, leaseUntil: 0, permitUsed: false, absence: undefined });
  } else {
    await ctx.db.patch(op._id, { state: args.continue && (cancelled || revoked) ? (cancelled ? 'cancelled' : 'paused') : 'confirmed' });
    if (args.usage !== undefined) await release(ctx, op);
  }
  await missingUsage(ctx, op);
  await event(ctx, op, cancelled ? (revoked ? 'completedAfterCancellationAndRevocation' : 'completedAfterCancellation') : revoked ? 'completedAfterRevocation' : op.absence ? 'completedAfterAbsence' : 'confirmed', { kind: 'adapter', id: op.bindingId }, { usageDelta: actual, usageKnown: args.usage !== undefined });
  return { accepted: true, late, overrun, ...(args.continue && (!continuing || total >= op.reserved || overrun || cancelled || revoked || op.released) ? { continuationRefused: true } : {}) };
} });
export const fail = internalMutation({ args: { ...target, retryable: v.boolean() }, handler: async (ctx, args) => {
  const op = await adapterOp(ctx, args.credentialHash, args.id);
  if (['cancelled', 'refused', 'outcomeUnknown'].includes(op.state)) return;
  if (op.fence !== args.fence || op.step !== args.step || !['dispatching', 'cancellationPending'].includes(op.state)) deny('FORBIDDEN', 'Stale failure');
  // An adapter error cannot establish the absence of provider cost.
  const pending = unresolved(op), cancelled = op.cancelRequestedAt !== undefined, retry = args.retryable && op.attempts < LIMITS.attempts && !cancelled && !pending;
  await ctx.db.patch(op._id, { state: pending ? 'outcomeUnknown' : cancelled ? 'cancelled' : retry ? 'queued' : 'refused', fence: op.fence + 1, worker: undefined, leaseUntil: 0, permitUsed: false });
  if (!retry && !pending) await release(ctx, op);
  await event(ctx, op, pending ? 'outcomeUnknown' : retry ? 'retryableRejection' : 'terminalRejection', { kind: 'adapter', id: op.bindingId });
} });
async function settleAbsence(ctx: MutationCtx, op: Operation, args: { fence: number; step: number; finality: 'provisional' | 'final'; evidence: string }, who: { kind: 'adapter' | 'user'; id: string }) {
  if (!args.evidence.trim() || args.evidence.length > 2000) deny('VALIDATION', 'Authoritative evidence or operator reason required');
  if (args.step !== op.step || op.receipts.some(r => r.step === args.step) || !op.consumedPermits.some(p => p.fence === args.fence && p.step === args.step)) deny('FORBIDDEN', 'Not current unknown step');
  if (op.absence?.finality === 'final') return;
  if (op.state !== 'outcomeUnknown') deny('FORBIDDEN', 'Not unknown');
  const absence = { finality: args.finality, by: who.id, at: Date.now(), evidence: args.evidence };
  let valid = true; try { await checked(ctx, op); } catch { valid = false; }
  if (args.finality === 'final') {
    await ctx.db.patch(op._id, { absence, state: op.cancelRequestedAt !== undefined ? 'cancelled' : 'refused' }); await release(ctx, op);
  } else await ctx.db.patch(op._id, { absence, state: valid ? 'queued' : 'outcomeUnknown', fence: valid ? op.fence + 1 : op.fence, worker: undefined, leaseUntil: 0, permitUsed: false });
  await event(ctx, op, 'authoritativeAbsence:' + args.finality, who);
}
const absenceArgs = { fence: v.number(), step: v.number(), finality: v.union(v.literal('provisional'), v.literal('final')), evidence: v.string() };
export const resolveUnknown = internalMutation({ args: { credentialHash: v.string(), id: v.id('integrationOps'), ...absenceArgs }, handler: async (ctx, args) => {
  const op = await adapterOp(ctx, args.credentialHash, args.id), binding = (await ctx.db.get(op.bindingId))!;
  const provider = await ctx.db.query('integrationProviders').withIndex('by_provider', q => q.eq('provider', binding.provider)).unique();
  if (args.finality === 'final' && !provider?.finalityRules.some(r => r.capability === op.capability)) deny('FORBIDDEN', 'Provider finality is not proven');
  await settleAbsence(ctx, op, args, { kind: 'adapter', id: binding.connectionId });
} });
export const operatorResolveUnknown = mutation({ args: { orgId: v.id('orgs'), id: v.id('integrationOps'), ...absenceArgs }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId, 'owner');
  const op = await ownOp(ctx, principal, args.id);
  if (args.finality === 'final' && op.capability.startsWith('billing.')) deny('FORBIDDEN', 'Financial uncertainty requires authoritative provider lookup');
  await settleAbsence(ctx, op, args, principal.actor);
} });
