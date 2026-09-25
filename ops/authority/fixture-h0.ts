import { internalMutation } from './_generated/server';
import { v } from 'convex/values';

// Scratch-only: lets the H0 replay exercise a second credential for the same
// provider tuple, a configuration production correctly refuses to create.
export const cloneConnection = internalMutation({ args: { connectionId: v.id('integrationConnections'), credentialHash: v.string() }, handler: async (ctx, args) => {
  const connection = await ctx.db.get(args.connectionId);
  if (!connection) throw new Error('Synthetic connection missing');
  const { _id, _creationTime, ...copy } = connection;
  return ctx.db.insert('integrationConnections', { ...copy, credentialHash: args.credentialHash });
} });
export const recipient = internalMutation({ args: { bindingId: v.id('integrationBindings'), recipient: v.string() }, handler: async (ctx, args) => {
  await ctx.db.patch(args.bindingId, { recipient: args.recipient });
} });
