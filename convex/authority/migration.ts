import { internalMutation } from '../_generated/server';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { v } from 'convex/values';
import { fail } from '../errors';

export async function snapshot(ctx: QueryCtx | MutationCtx, orgId: Id<'orgs'>, cutoff?: number) {
  const objects = await ctx.db.query('objects').withIndex('by_org', q => q.eq('orgId', orgId)).collect();
  return objects.filter(o => cutoff === undefined || o._creationTime <= cutoff);
}
export function expand(grants: Doc<'agents'>['grants'], objects: Doc<'objects'>[]) {
  const result = new Map<string, Doc<'agents'>['grants'][number]>();
  for (const grant of grants) for (const object of objects) {
    if (grant.objectKey === '*' || grant.objectKey === object.key) result.set(`${grant.action}:${object._id}`, { action: grant.action, objectKey: object.key, objectId: object._id });
  }
  return [...result.values()];
}
// Schema-only R0 installs this function before the enforcement release. Never
// move a saved cutoff: object creation racing a later batch must not widen it.
export const freeze = internalMutation({ args: { orgId: v.id('orgs') }, handler: async (ctx, { orgId }) => {
  const org = await ctx.db.get(orgId); if (!org) fail('NOT_FOUND');
  if (org.authorityFrozenAt !== undefined) return org.authorityFrozenAt;
  const objects = await snapshot(ctx, orgId), cutoff = Math.max(Date.now(), ...objects.map(o => o._creationTime));
  await ctx.db.patch(orgId, { authorityFrozenAt: cutoff });
  await ctx.db.insert('authorityAudit', { orgId, actor: { kind: 'operator', id: 'migration' }, action: 'authorityFrozen', targetId: orgId, objectIds: objects.map(o => o._id) });
  return cutoff;
} });
export const migrateAgent = internalMutation({ args: { agentId: v.id('agents') }, handler: async (ctx, { agentId }) => {
  const agent = await ctx.db.get(agentId); if (!agent) fail('NOT_FOUND');
  if (agent.authorityVersion === 1) return { changed: false, dropped: [] };
  const org = await ctx.db.get(agent.orgId);
  if (org?.authorityFrozenAt === undefined) fail('AUTHORITY_MIGRATING', 'Freeze workspace authority before migration', { retryable: true });
  const objects = await snapshot(ctx, agent.orgId, org.authorityFrozenAt), keys = new Set(objects.map(o => o.key));
  const dropped = agent.grants.filter(g => g.objectKey !== '*' && !keys.has(g.objectKey)).map(g => `${g.action}:${g.objectKey}`);
  await ctx.db.patch(agentId, { sharedInbox: agent.sharedInbox ?? agent._creationTime <= org.authorityFrozenAt, grants: expand(agent.grants, objects), readObjectIds: objects.map(o => o._id), authorityVersion: 1, authorityEpoch: agent.authorityEpoch ?? 0, origin: agent.origin ?? 'external', state: agent.state ?? (agent.revokedAt === undefined ? 'active' : 'fired') });
  await ctx.db.insert('authorityAudit', { orgId: agent.orgId, actor: { kind: 'operator', id: 'migration' }, action: 'legacyAuthorityExpanded', targetId: agentId, objectIds: objects.map(o => o._id) });
  return { changed: true, dropped };
} });
