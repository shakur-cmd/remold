import {internalMutation} from './_generated/server';
import {v} from 'convex/values';
export const bindContact = internalMutation({args:{binding:v.id('bindings'),externalId:v.string()},handler:async(ctx,a)=>{
 const binding=await ctx.db.get(a.binding);if(!binding)throw Error('Unknown synthetic binding');
 await ctx.db.patch(binding._id,{externalId:a.externalId});
}});
