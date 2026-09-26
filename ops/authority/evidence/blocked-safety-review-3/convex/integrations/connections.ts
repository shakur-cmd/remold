import { pauseWork } from './lifecycle';
import { action, internalMutation, mutation, query, type QueryCtx, type MutationCtx } from '../_generated/server';
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { finalityRule } from '../../packages/contracts/integrations';
import type { Doc, Id } from '../_generated/dataModel';
import { requireMember } from '../identity';
import { writable } from '../authority/readonly';
import { fail } from '../errors';
type Ctx = QueryCtx | MutationCtx;
export async function provider(ctx: Ctx, name: string) {
  const p = await ctx.db.query('integrationProviders').withIndex('by_provider', q => q.eq('provider', name)).unique();
  if (!p?.enabled) fail('FORBIDDEN', 'Provider is not enabled');
}
export async function usable(ctx: Ctx, connection: Doc<'integrationConnections'>) {
  await provider(ctx, connection.provider);
  const ref = await ctx.db.get(connection.secretReferenceId);
  if (!connection.connected || !connection.healthy || !ref?.active || ref.orgId !== connection.orgId || ref.provider !== connection.provider || ref.environment !== connection.environment || ref.account !== connection.account) fail('FORBIDDEN', 'Integration requires reconnection');
  return ref;
}
export async function adapter(ctx: Ctx, credentialHash: string) {
  const connection = await ctx.db.query('integrationConnections').withIndex('by_credential', q => q.eq('credentialHash', credentialHash)).unique();
  if (!connection) fail('UNAUTHENTICATED', 'Invalid adapter credential');
  return connection;
}
export async function bound(ctx: Ctx, credentialHash: string, bindingId: Id<'integrationBindings'>) {
  const connection = await adapter(ctx, credentialHash), binding = await ctx.db.get(bindingId);
  if (!binding || binding.orgId !== connection.orgId || binding.connectionId !== connection._id || binding.provider !== connection.provider || binding.environment !== connection.environment || binding.account !== connection.account) fail('NOT_FOUND', 'Binding not found');
  return { connection, binding };
}
// Only an operator installs provider adapters or vault handles. No public input
// can create a provider, substitute an account, or supply raw credentials.
export const registerProvider = internalMutation({ args: { provider: v.string(), enabled: v.boolean(), finalityRules: v.optional(v.array(finalityRule)) }, handler: async (ctx, args) => {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(args.provider)) fail('VALIDATION');
  if ((args.finalityRules ?? []).some(r => !r.semantics.trim() || !r.proofRef.trim())) fail('VALIDATION', 'Auditable provider finality semantics and selection proof required');
  const existing = await ctx.db.query('integrationProviders').withIndex('by_provider', q => q.eq('provider', args.provider)).unique();
  return existing ? ctx.db.patch(existing._id, { enabled: args.enabled, finalityRules: args.finalityRules ?? [] }) : ctx.db.insert('integrationProviders', { ...args, finalityRules: args.finalityRules ?? [] });
} });
export const registerSecret = internalMutation({ args: { orgId: v.id('orgs'), provider: v.string(), environment: v.string(), account: v.string(), handle: v.string() }, handler: async (ctx, args) => {
  await provider(ctx, args.provider); if (!(await ctx.db.get(args.orgId))) fail('NOT_FOUND');
  if (!/^vault:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(args.handle)) fail('VALIDATION', 'Opaque vault reference required');
  return ctx.db.insert('secretReferences', { ...args, active: true, version: 1 });
} });
const args = { orgId: v.id('orgs'), secretReferenceId: v.id('secretReferences') };
export const connect = action({ args, handler: async (ctx, input): Promise<{ connectionId: Id<'integrationConnections'>; adapterKey: string }> => {
  const adapterKey = 'ra_' + [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
  const credentialHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(adapterKey)))].map(b => b.toString(16).padStart(2, '0')).join('');
  const connectionId = await ctx.runMutation(makeFunctionReference<'mutation'>('integrations/connections:insert'), { ...input, credentialHash }) as Id<'integrationConnections'>;
  return { connectionId, adapterKey };
} });
export const insert = internalMutation({ args: { ...args, credentialHash: v.string() }, handler: async (ctx, args) => {
  await requireMember(ctx, args.orgId, 'owner'); await writable(ctx, args.orgId);
  const ref = await ctx.db.get(args.secretReferenceId); if (!ref || ref.orgId !== args.orgId || !ref.active) fail('NOT_FOUND', 'Secret reference not found'); await provider(ctx, ref.provider);
  if (!/^[a-f0-9]{64}$/.test(args.credentialHash)) fail('VALIDATION');
  const existing = await ctx.db.query('integrationConnections').withIndex('by_tuple', q => q.eq('provider', ref.provider).eq('environment', ref.environment).eq('account', ref.account)).unique();
  if (existing) fail('CONFLICT', 'Account already bound');
  return ctx.db.insert('integrationConnections', { orgId: args.orgId, secretReferenceId: ref._id, credentialHash: args.credentialHash, provider: ref.provider, environment: ref.environment, account: ref.account, connected: true, healthy: true, version: 1 });
} });
export const list = query({ args: { orgId: v.id('orgs') }, handler: async (ctx, args) => {
  await requireMember(ctx, args.orgId, 'admin');
  return (await ctx.db.query('integrationConnections').withIndex('by_org', q => q.eq('orgId', args.orgId)).collect()).map(c => ({ id: c._id, provider: c.provider, environment: c.environment, account: c.account, connected: c.connected, healthy: c.healthy, version: c.version }));
} });
export const disconnect = mutation({ args: { orgId: v.id('orgs'), connectionId: v.id('integrationConnections') }, handler: async (ctx, args) => {
  const owner = await requireMember(ctx, args.orgId, 'owner'), connection = await ctx.db.get(args.connectionId);
  if (!connection || connection.orgId !== args.orgId) fail('NOT_FOUND');
  await ctx.db.patch(connection._id, { connected: false, version: connection.version + 1 });
  await pauseWork(ctx, args.orgId);
  await ctx.db.insert('integrationEvents', { orgId: args.orgId, actor: owner.actor, name: 'connectionDisconnected', at: Date.now() });
} });
