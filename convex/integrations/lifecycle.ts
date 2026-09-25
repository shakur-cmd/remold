import { internalMutation, type MutationCtx } from '../_generated/server';
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../_generated/dataModel';
import { v } from 'convex/values';
import { epoch, principalFor } from '../authority/grants';
import { fail } from '../errors';
import { usable } from './connections';
import { authority, checked, event, release, unresolved } from './core';
export const expire = internalMutation({ args: { id: v.id('integrationOps'), fence: v.number(), step: v.number() }, handler: async (ctx, args) => {
  const op = await ctx.db.get(args.id);
  if (!op || op.fence !== args.fence || op.step !== args.step || !['dispatching', 'cancellationPending'].includes(op.state) || op.permitUntil > Date.now() || (op.permitUsed && op.leaseUntil > Date.now())) return;
  let state: 'queued' | 'paused' | 'cancelled' = op.cancelRequestedAt !== undefined ? 'cancelled' : 'queued';
  if (!op.permitUsed && state === 'queued') try { await checked(ctx, op); } catch { state = 'paused'; }
  const pending = unresolved(op);
  await ctx.db.patch(op._id, pending ? { state: 'outcomeUnknown' } : { state, fence: op.fence + 1, worker: undefined, leaseUntil: 0 });
  if (!pending && state !== 'queued') await release(ctx, op);
  await event(ctx, op, pending ? 'outcomeUnknown' : 'unconsumedPermitExpired', { kind: 'scheduler', id: 'expiry' });
} });
export async function pauseWork(ctx: MutationCtx, orgId: Id<'orgs'>) {
  await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('integrations/lifecycle:sweep'), { orgId, cursor: null });
}
export const sweep = internalMutation({ args: { orgId: v.id('orgs'), cursor: v.union(v.string(), v.null()) }, handler: async (ctx, args) => {
  const page = await ctx.db.query('integrationOps').withIndex('by_org', q => q.eq('orgId', args.orgId)).paginate({ cursor: args.cursor, numItems: 100 });
  for (const op of page.page) {
    if (['confirmed', 'cancelled', 'refused', 'paused'].includes(op.state)) continue;
    try {
      if (op.state === 'proposed') {
        const actor = await principalFor(ctx, op.orgId, op.actor);
        if (epoch(actor) !== op.actorEpoch || ('member' in actor && actor.member._id !== op.actorMembershipId)) fail('FORBIDDEN');
        if ('agent' in actor) await authority(ctx, actor, op);
        const binding = await ctx.db.get(op.bindingId), connection = binding ? await ctx.db.get(binding.connectionId) : null;
        if (!binding?.connected || !connection) fail('FORBIDDEN');
        await usable(ctx, connection);
      } else await checked(ctx, op);
    } catch {
      const inflight = ['dispatching', 'cancellationPending'].includes(op.state), pending = unresolved(op);
      await ctx.db.patch(op._id, { state: inflight ? 'cancellationPending' : pending ? 'outcomeUnknown' : 'paused' });
      if (!inflight && !pending) await release(ctx, op);
      await event(ctx, op, 'authorityPaused', { kind: 'scheduler', id: 'authority' });
    }
  }
  if (!page.isDone) await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('integrations/lifecycle:sweep'), { orgId: args.orgId, cursor: page.continueCursor });
} });
