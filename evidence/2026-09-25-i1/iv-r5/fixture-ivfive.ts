import { internalMutation } from './_generated/server';
import { v } from 'convex/values';
// IV round 5 scratch controls, copied by local.mjs into an anonymous loopback backend only.
// Recreate pre-audience inbox rows and a later freeze, which production data can hold but new code never writes.
export const clearAudience = internalMutation({ args: { id: v.id('agentInbox') }, handler: async (ctx, args) => { await ctx.db.patch(args.id, { audience: undefined }); } });
export const setFreeze = internalMutation({ args: { orgId: v.id('orgs'), at: v.number() }, handler: async (ctx, args) => { await ctx.db.patch(args.orgId, { authorityFrozenAt: args.at }); } });
