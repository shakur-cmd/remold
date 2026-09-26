import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
// IV-only scratch controls. Copied by local.mjs into an anonymous loopback backend only.
export const patchSecret = internalMutation({ args: { id: v.id('secretReferences'), environment: v.optional(v.string()), provider: v.optional(v.string()), account: v.optional(v.string()) }, handler: async (ctx, { id, ...patch }) => { await ctx.db.patch(id, patch); } });
export const renameObject = internalMutation({ args: { objectId: v.id('objects'), key: v.string() }, handler: async (ctx, args) => { await ctx.db.patch(args.objectId, { key: args.key }); } });
export const readonly = internalMutation({ args: { orgId: v.id('orgs'), readonly: v.boolean() }, handler: async (ctx, args) => { const org = await ctx.db.get(args.orgId); await ctx.db.patch(args.orgId, { flags: { ...(org?.flags ?? {}), readonly: args.readonly } }); } });
export const scheduled = internalQuery({ args: {}, handler: async (ctx) => (await ctx.db.system.query('_scheduled_functions').collect()).map(s => ({ name: s.name, state: s.state.kind, at: s.scheduledTime })) });
const clean = (row: any) => { const { _creationTime, ...value } = row; return value; };
// Wider than the builder's dump: includes the org row itself, invites, links, secrets, budgets and ops events.
export const everything = internalQuery({ args: { orgId: v.id('orgs') }, handler: async (ctx, { orgId }) => {
  const tables = ['agents', 'objects', 'fields', 'records', 'events', 'suggestions', 'agentInbox', 'members', 'invites', 'links', 'capabilityGrants', 'authorityAudit', 'integrationConnections', 'integrationIntents', 'integrationBindings', 'integrationOps', 'integrationEvents', 'consent', 'safetyTargets', 'integrationReceipts', 'secretReferences', 'opsEvents'];
  const out: Record<string, unknown> = { org: clean(await ctx.db.get(orgId)), budget: (await ctx.db.query('usageBudgets').collect()).filter((b: any) => b.key === orgId).map(clean) };
  for (const table of tables) { try { out[table] = (await ctx.db.query(table as any).collect()).filter((row: any) => row.orgId === orgId).map(clean); } catch { out[table] = 'n/a'; } }
  return out;
} });
// r2: the same state changes the public mutations make, minus the scheduled pause sweep,
// so the final-permit recheck is exercised without the sweep racing it.
export const setRoleNoSweep = internalMutation({ args: { orgId: v.id('orgs'), userId: v.id('users'), role: v.union(v.literal('admin'), v.literal('member'), v.literal('owner')) }, handler: async (ctx, args) => { const m = await ctx.db.query('members').withIndex('by_org_user', q => q.eq('orgId', args.orgId).eq('userId', args.userId)).unique(); if (!m) throw new Error('missing'); await ctx.db.patch(m._id, { role: args.role, authorityEpoch: (m.authorityEpoch ?? 0) + 1 }); } });
export const revokeGrantNoSweep = internalMutation({ args: { id: v.id('capabilityGrants') }, handler: async (ctx, args) => { const g = await ctx.db.get(args.id); if (!g) throw new Error('missing'); await ctx.db.patch(g._id, { revokedAt: Date.now() }); const a = await ctx.db.get(g.agentId); if (a) await ctx.db.patch(a._id, { authorityEpoch: (a.authorityEpoch ?? 0) + 1 }); } });
// r2: turn a freshly created agent back into a pre-I1 legacy agent (grants by object key only).
export const makeLegacy = internalMutation({ args: { agentId: v.id('agents'), grants: v.array(v.object({ action: v.union(v.literal('create'), v.literal('update'), v.literal('delete')), objectKey: v.string() })) }, handler: async (ctx, args) => { await ctx.db.patch(args.agentId, { authorityVersion: undefined, readObjectIds: undefined, grants: args.grants }); } });
export const handles = internalQuery({ args: {}, handler: async (ctx) => (await ctx.db.query('secretReferences').collect()).map((s: any) => s.handle) });
