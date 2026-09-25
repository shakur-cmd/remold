import { internalAction, internalMutation, internalQuery } from '../_generated/server';
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { adapter } from './connections';
import { fail } from '../errors';
export const pages = internalQuery({ args: { credentialHash: v.string(), resource: v.string() }, handler: async (ctx, args) => {
  const connection = await adapter(ctx, args.credentialHash);
  const cursor = await ctx.db.query('integrationCursors').withIndex('by_resource', q => q.eq('connectionId', connection._id).eq('resource', args.resource)).unique();
  if (!cursor?.complete) fail('CONFLICT', 'Lookup traversal incomplete');
  const pages = await ctx.db.query('integrationPages').withIndex('by_page', q => q.eq('cursorId', cursor._id).eq('traversal', cursor.traversal)).collect();
  if (pages.length !== cursor.nextPage - 1) fail('CONFLICT', 'Lookup pages missing');
  return { cursorId: cursor._id, traversal: cursor.traversal, pageCount: pages.length, contents: pages.sort((a, b) => a.page - b.page).map(p => p.digest) };
} });
export const seal = internalAction({ args: { credentialHash: v.string(), resource: v.string() }, handler: async (ctx, args): Promise<string> => {
  const data = await ctx.runQuery(makeFunctionReference<'query'>('integrations/lookups:pages'), args);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(data.contents))))].map(b => b.toString(16).padStart(2, '0')).join('');
  const { contents: _contents, ...proof } = data;
  return ctx.runMutation(makeFunctionReference<'mutation'>('integrations/lookups:record'), { credentialHash: args.credentialHash, ...proof, digest });
} });
export const record = internalMutation({ args: { credentialHash: v.string(), cursorId: v.id('integrationCursors'), traversal: v.string(), pageCount: v.number(), digest: v.string() }, handler: async (ctx, args) => {
  const connection = await adapter(ctx, args.credentialHash), cursor = await ctx.db.get(args.cursorId);
  if (!cursor?.complete || cursor.connectionId !== connection._id || cursor.traversal !== args.traversal || cursor.nextPage - 1 !== args.pageCount) fail('CONFLICT', 'Lookup changed while sealing');
  const prior = await ctx.db.query('integrationLookups').withIndex('by_traversal', q => q.eq('cursorId', cursor._id).eq('traversal', cursor.traversal)).unique();
  if (prior) { if (prior.digest !== args.digest) fail('CONFLICT', 'Lookup integrity mismatch'); return prior._id; }
  return ctx.db.insert('integrationLookups', { orgId: connection.orgId, connectionId: connection._id, cursorId: cursor._id, resource: cursor.resource, traversal: cursor.traversal, pageCount: args.pageCount, digest: args.digest, completedAt: Date.now() });
} });
