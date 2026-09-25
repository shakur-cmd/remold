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
