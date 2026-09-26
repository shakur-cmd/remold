import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
export const customer = internalQuery({ args: { id: v.id('payCustomers') }, handler: (ctx, a) => ctx.db.get(a.id) });
export const epoch = internalMutation({ args: { actor: v.id('actors') }, handler: async (ctx, a) => {
        const actor = await ctx.db.get(a.actor);
        if (!actor)
            throw Error('missing actor');
        await ctx.db.patch(actor._id, { epoch: actor.epoch + 1 });
    } });
