import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
// Synthetic fixture control, copied only into an anonymous loopback deployment.
export const flags = internalMutation({ args: { orgId: v.id('orgs'), readonly: v.boolean() }, handler: async (ctx, args) => { await ctx.db.patch(args.orgId, { flags: { readonly: args.readonly } }); } });
export const consent = internalMutation({ args: { orgId: v.id('orgs'), recipient: v.string() }, handler: async (ctx, args) => ctx.db.insert('consent', { ...args, channel: 'email', purpose: 'marketing', suppressed: false, source: 'synthetic explicit test consent', version: 1, at: Date.now() }) });
export const dump = internalQuery({ args: { orgId: v.id('orgs') }, handler: async (ctx, args) => ({
  budgets: await ctx.db.query('usageBudgets').collect(),
  operations: await ctx.db.query('integrationOps').withIndex('by_org', q => q.eq('orgId', args.orgId)).collect(),
  events: await ctx.db.query('integrationEvents').withIndex('by_org_at', q => q.eq('orgId', args.orgId)).collect(),
  grants: (await ctx.db.query('capabilityGrants').collect()).filter(g => g.orgId === args.orgId),
  bindings: await ctx.db.query('integrationBindings').withIndex('by_org', q => q.eq('orgId', args.orgId)).collect(),
  consent: (await ctx.db.query('consent').collect()).filter(c => c.orgId === args.orgId),
  safetyTargets: (await ctx.db.query('safetyTargets').collect()).filter(c => c.orgId === args.orgId),
  receipts: (await ctx.db.query('integrationReceipts').collect()).filter(c => c.orgId === args.orgId),
}) });
export const bumpMember = internalMutation({ args: { orgId: v.id('orgs'), userId: v.id('users') }, handler: async (ctx, args) => { const member = await ctx.db.query('members').withIndex('by_org_user', q => q.eq('orgId', args.orgId).eq('userId', args.userId)).unique(); if (!member) throw Error('Synthetic member missing'); await ctx.db.patch(member._id, { authorityEpoch: (member.authorityEpoch ?? 0) + 1 }); } });
export const revokeSecret = internalMutation({ args: { id: v.id('secretReferences') }, handler: async (ctx, args) => ctx.db.patch(args.id, { active: false }) });
