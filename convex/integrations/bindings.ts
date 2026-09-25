import { mutation, internalMutation } from '../_generated/server';
import { v } from 'convex/values';
import { requireMember } from '../identity';
import { writable } from '../authority/readonly';
import { fail } from '../errors';
import { adapter, usable } from './connections';
import { approveBindingRead } from './core';
import { pauseWork } from './lifecycle';
export const provision = mutation({ args: { orgId: v.id('orgs'), connectionId: v.id('integrationConnections'), logical: v.string(), kind: v.string(), localRecordId: v.optional(v.id('records')), recipient: v.optional(v.string()), remove: v.boolean() }, handler: async (ctx, args) => {
  const human = await requireMember(ctx, args.orgId, 'admin'), connection = await ctx.db.get(args.connectionId);
  if (!connection || connection.orgId !== args.orgId) fail('NOT_FOUND');
  if (!args.remove) { await writable(ctx, args.orgId); await usable(ctx, connection); }
  if (!args.logical || args.logical.length > 200 || !args.kind || args.kind.length > 80 || (args.recipient !== undefined && (!args.recipient || args.recipient.length > 300))) fail('VALIDATION');
  if (args.localRecordId) {
    const record = await ctx.db.get(args.localRecordId); if (!record || record.orgId !== args.orgId) fail('NOT_FOUND');
    await approveBindingRead(ctx, human, { localRecordId: args.localRecordId });
  }
  const prior = await ctx.db.query('integrationIntents').withIndex('by_logical', q => q.eq('connectionId', connection._id).eq('logical', args.logical)).unique();
  if (prior) {
    if (prior.kind !== args.kind || prior.localRecordId !== args.localRecordId || prior.recipient !== args.recipient) fail('CONFLICT', 'Intent target differs');
    if (args.remove) {
      await ctx.db.patch(prior._id, { desired: 'deleted', cleanupRequired: !!prior.externalId });
      if (prior.externalId) {
        const binding = await ctx.db.query('integrationBindings').withIndex('by_tuple', q => q.eq('provider', connection.provider).eq('environment', connection.environment).eq('account', connection.account).eq('kind', prior.kind).eq('externalId', prior.externalId!)).unique();
        if (binding?.orgId === args.orgId && binding.connectionId === connection._id) await ctx.db.patch(binding._id, { connected: false });
      }
      await pauseWork(ctx, args.orgId);
      await ctx.db.insert('integrationEvents', { orgId: args.orgId, actor: human.actor, name: 'provisionDeleted', at: Date.now() });
    }
    return prior._id;
  }
  const { remove, ...input } = args;
  const id = await ctx.db.insert('integrationIntents', { ...input, desired: remove ? 'deleted' : 'present', cleanupRequired: false });
  await ctx.db.insert('integrationEvents', { orgId: args.orgId, actor: human.actor, name: remove ? 'provisionDeleted' : 'provisionRequested', at: Date.now() }); return id;
} });
export const bind = internalMutation({ args: { credentialHash: v.string(), intentId: v.id('integrationIntents'), externalId: v.string() }, handler: async (ctx, args) => {
  const connection = await adapter(ctx, args.credentialHash), intent = await ctx.db.get(args.intentId);
  if (!intent || intent.connectionId !== connection._id || intent.orgId !== connection.orgId) fail('NOT_FOUND');
  if (!args.externalId || args.externalId.length > 300) fail('VALIDATION');
  if (intent.externalId && intent.externalId !== args.externalId) fail('CONFLICT', 'Duplicate external create');
  await ctx.db.patch(intent._id, { externalId: args.externalId, cleanupRequired: intent.desired === 'deleted' });
  // Preserve observed creation after a concurrent deletion without making it usable.
  if (intent.desired === 'deleted') return { cleanupRequired: true, bindingId: null };
  const prior = await ctx.db.query('integrationBindings').withIndex('by_tuple', q => q.eq('provider', connection.provider).eq('environment', connection.environment).eq('account', connection.account).eq('kind', intent.kind).eq('externalId', args.externalId)).unique();
  if (prior) {
    if (prior.orgId !== intent.orgId || prior.connectionId !== connection._id || prior.localRecordId !== intent.localRecordId || prior.recipient !== intent.recipient) fail('CONFLICT', 'Binding collision');
    return { bindingId: prior._id, cleanupRequired: false };
  }
  const bindingId = await ctx.db.insert('integrationBindings', { orgId: intent.orgId, connectionId: connection._id, provider: connection.provider, environment: connection.environment, account: connection.account, kind: intent.kind, externalId: args.externalId, localRecordId: intent.localRecordId, recipient: intent.recipient, connected: true });
  await ctx.db.insert('integrationEvents', { orgId: intent.orgId, bindingId, actor: { kind: 'adapter', id: connection._id }, name: 'bindingCreated', at: Date.now() }); return { bindingId, cleanupRequired: false };
} });
