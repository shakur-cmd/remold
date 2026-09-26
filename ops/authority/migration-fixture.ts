import { internalQuery, internalMutation } from './_generated/server';
import { v } from 'convex/values';
export const snapshot = internalQuery({ args: { orgId: v.id('orgs') }, handler: async (ctx, args) => ({ org: await ctx.db.get(args.orgId), agents: await ctx.db.query('agents').withIndex('by_org', q => q.eq('orgId', args.orgId)).collect(), objects: await ctx.db.query('objects').withIndex('by_org', q => q.eq('orgId', args.orgId)).collect(), records: await ctx.db.query('records').withIndex('by_object', q => q.eq('orgId', args.orgId)).collect() }) });
export const keyReuse = internalMutation({ args: { objectId: v.id('objects'), key: v.string() }, handler: async (ctx, args) => ctx.db.patch(args.objectId, { key: args.key }) });
