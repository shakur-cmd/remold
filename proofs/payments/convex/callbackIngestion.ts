import { mutation, query } from './_generated/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { v } from 'convex/values';
// Additive to the frozen payments module: read a binding's durable callback receipts and close a refused one with an attributed event.
async function adapter(ctx: MutationCtx | QueryCtx, token: string, binding: Id<'bindings'>) {
    const b = await ctx.db.get(binding), s = await ctx.db.query('sessions').withIndex('token', q => q.eq('token', token)).unique(), a = s?.adapterScope;
    if (!b || !a || a.provider !== b.provider || a.environment !== b.environment || a.account !== b.account) throw new Error('adapter account denied');
    return b;
}
export const receipts = query({ args: { token: v.string(), binding: v.id('bindings') }, handler: async (ctx, a) => {
    await adapter(ctx, a.token, a.binding);
    const rows = await ctx.db.query('payIncoming').withIndex('event', q => q.eq('binding', a.binding)).take(101);
    if (rows.length > 100) throw new Error('receipt bound reached');
    return rows.map(({ eventId, type, externalId, digest, done }) => ({ eventId, type, externalId, digest, done }));
} });
export const refuse = mutation({ args: { token: v.string(), id: v.id('payIncoming'), reason: v.string() }, handler: async (ctx, a) => {
    const e = await ctx.db.get(a.id);
    if (!e) throw new Error('event missing');
    const b = await adapter(ctx, a.token, e.binding);
    if (e.done) return false;
    await ctx.db.patch(e._id, { done: true });
    await ctx.db.insert('events', { org: b.org, actor: 'trusted-stripe-adapter', kind: 'payment.callback.refused:' + a.reason.slice(0, 80), resource: e._id, at: Date.now() });
    return true;
} });
