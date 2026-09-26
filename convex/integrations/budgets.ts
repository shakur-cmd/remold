import { internalMutation } from '../_generated/server';
import { v } from 'convex/values';
import { fail } from '../errors';
import { writable } from '../authority/readonly';
export const configure = internalMutation({ args: { orgId: v.optional(v.id('orgs')), cap: v.number(), maxConcurrent: v.number(), maxPerRun: v.number(), maxSteps: v.number(), maxRecipients: v.number() }, handler: async (ctx, args) => {
  if (Object.entries(args).some(([k, n]) => k !== 'orgId' && (!Number.isSafeInteger(n) || Number(n) < 0))) fail('VALIDATION', 'Nonnegative integer limits required');
  if (args.maxSteps > 5 || args.maxRecipients > 100) fail('VALIDATION', 'Unsupported batch bound');
  // A workspace in readonly keeps its limits; the global budget belongs to no workspace.
  if (args.orgId) await writable(ctx, args.orgId);
  const key = args.orgId ?? 'global', existing = await ctx.db.query('usageBudgets').withIndex('by_key', q => q.eq('key', key)).unique();
  if (existing) await ctx.db.patch(existing._id, args);
  else await ctx.db.insert('usageBudgets', { ...args, key, reserved: 0, active: 0, spent: 0, missingUsage: false, missingUsageCount: 0 });
} });
export const clearAnomaly = internalMutation({ args: { orgId: v.optional(v.id('orgs')) }, handler: async (ctx, args) => {
  const budget = await ctx.db.query('usageBudgets').withIndex('by_key', q => q.eq('key', args.orgId ?? 'global')).unique();
  if (!budget) fail('NOT_FOUND');
  await ctx.db.patch(budget._id, { anomaly: undefined });
  if (args.orgId) await ctx.db.insert('integrationEvents', { orgId: args.orgId, actor: { kind: 'operator', id: 'internal-admin' }, name: 'budgetAnomalyCleared', at: Date.now() });
} });
