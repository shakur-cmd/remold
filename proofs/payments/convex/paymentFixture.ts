import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
export const customer = internalMutation({ args: { org: v.id('orgs'), binding: v.id('bindings'), name: v.string() }, handler: async (ctx, a) => ctx.db.insert('payCustomers', { ...a, externalId: 'cus_synthetic_' + a.name, deleted: false }) });
export const role = internalMutation({ args: { actor: v.id('actors'), role: v.union(v.literal('admin'), v.literal('finance'), v.literal('viewer'), v.literal('removed')) }, handler: async (ctx, a) => { const old = await ctx.db.query('financeMembers').withIndex('actor', q => q.eq('actor', a.actor)).unique(); if (old)
        await ctx.db.patch(old._id, { role: a.role });
    else
        await ctx.db.insert('financeMembers', a); } });
export const counts = internalMutation({ args: { org: v.id('orgs') }, handler: async (ctx, a) => ({ operations: (await ctx.db.query('operations').collect()).filter(o => o.org === a.org).length, safety: (await ctx.db.query('safetyOps').collect()).filter(o => o.org === a.org).map(o => ({ action: o.action, state: o.state, late: o.late, amountMinor: o.amountMinor })), events: (await ctx.db.query('events').collect()).filter(o => o.org === a.org).map(({ kind, actor, resource }) => ({ kind, actor, resource })) }) });

export const recoveryOperations = internalQuery({ args: { org: v.id('orgs') }, handler: async (ctx, {org}) => ctx.db.query('operations').withIndex('logical', q => q.eq('org',org)).take(3) });
