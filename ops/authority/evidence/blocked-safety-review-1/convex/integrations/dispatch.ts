import { internalMutation, internalQuery } from '../_generated/server';
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { fail } from '../errors';
import { adapterOp, budgets, checked, event, LIMITS } from './core';
const target = { credentialHash: v.string(), id: v.id('integrationOps'), fence: v.number(), step: v.number() };
const expiry = makeFunctionReference<'mutation'>('integrations/lifecycle:expire');
export const permit = internalMutation({ args: { ...target, worker: v.string() }, handler: async (ctx, args) => {
  const op = await adapterOp(ctx, args.credentialHash, args.id);
  if (op.released || op.state !== 'queued' || op.fence !== args.fence || op.step !== args.step || op.worker !== args.worker || op.leaseUntil <= Date.now()) fail('FORBIDDEN', 'Stale claim');
  await checked(ctx, op);
  const { org, global } = await budgets(ctx, op.orgId);
  if (org.anomaly || global.anomaly || org.missingUsage) fail('FORBIDDEN', 'Usage or anomaly hold');
  const maxUnits = op.reserved - op.usage;
  if (maxUnits <= 0 || op.payload.schedule > Date.now() || op.attempts >= LIMITS.attempts) fail('FORBIDDEN', 'Dispatch bounds exceeded');
  for (const state of ['dispatching', 'cancellationPending'] as const) {
    const active = await ctx.db.query('integrationOps').withIndex('by_org_state', q => q.eq('orgId', op.orgId).eq('state', state)).first();
    if (active) fail('FORBIDDEN', 'Outstanding permit cap');
  }
  const expires = Date.now() + LIMITS.permitMs;
  await ctx.db.patch(op._id, { state: 'dispatching', permitUntil: expires, permitUsed: false, attempts: op.attempts + 1 });
  const id = { id: op._id, fence: op.fence, step: op.step };
  await ctx.scheduler.runAfter(LIMITS.permitMs + 1, expiry, id);
  await ctx.scheduler.runAfter(Math.max(1, op.leaseUntil - Date.now() + 1), expiry, id);
  await event(ctx, op, 'permitIssued', { kind: 'adapter', id: op.bindingId });
  return { id: op._id, version: op.version, bindingId: op.bindingId, fence: op.fence, step: op.step, worker: op.worker, expires, maxUnits, maxRecipients: op.payload.audience.length };
} });
export const consume = internalMutation({ args: { ...target, worker: v.string(), version: v.number(), bindingId: v.id('integrationBindings') }, handler: async (ctx, args) => {
  const op = await adapterOp(ctx, args.credentialHash, args.id);
  if (!['dispatching', 'cancellationPending'].includes(op.state) || op.permitUsed || op.permitUntil <= Date.now() || op.fence !== args.fence || op.step !== args.step || op.worker !== args.worker || op.version !== args.version || op.bindingId !== args.bindingId) fail('FORBIDDEN', 'Invalid or spent permit');
  if (op.consumedPermits.length >= LIMITS.consumed) fail('FORBIDDEN', 'Consumed permit bound');
  // General permits authorize one bounded tail after this point.
  await ctx.db.patch(op._id, { permitUsed: true, consumedPermits: [...op.consumedPermits, { fence: op.fence, step: op.step }] });
  await event(ctx, op, 'permitConsumed', { kind: 'adapter', id: op.bindingId });
  return { bindingId: op.bindingId, key: op._id + ':step:' + op.step, account: op.payload.destination, payload: op.payload, maxUnits: op.reserved - op.usage, maxRecipients: op.payload.audience.length };
} });
export const status = internalQuery({ args: target, handler: async (ctx, args) => {
  const op = await adapterOp(ctx, args.credentialHash, args.id);
  if (!(op.fence === args.fence && op.step === args.step) && !op.consumedPermits.some(p => p.fence === args.fence && p.step === args.step)) fail('FORBIDDEN', 'Stale status');
  let cancel = op.cancelRequestedAt !== undefined || op.leaseUntil <= Date.now() || ['paused', 'cancelled', 'refused', 'confirmed'].includes(op.state);
  try { await checked(ctx, op); } catch { cancel = true; }
  return { state: op.state, cancel };
} });
