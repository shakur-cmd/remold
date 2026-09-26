import { pauseWork } from '../integrations/lifecycle';
import { mutation } from '../_generated/server';
import { v } from 'convex/values';
import { recordScope, type RecordScope } from '../../packages/contracts/authority';
import { requireMember } from '../identity';
import { fail } from '../errors';
import { writable } from './readonly';
import { unrestrictedHuman } from './inbox';

const subset = (next: RecordScope[] | undefined, before: RecordScope[] | undefined) => before === undefined || (next !== undefined && next.every(n => before.some(p => p.objectId === n.objectId && (p.records === 'all' || (n.records !== 'all' && n.records.every(id => p.records.includes(id)))) && (p.fields === 'all' || (n.fields !== 'all' && n.fields.every(id => p.fields.includes(id)))))));

export const setMember = mutation({ args: { orgId: v.id('orgs'), memberId: v.id('members'), scopes: v.optional(v.array(recordScope)), hiddenFieldIds: v.array(v.id('fields')) }, handler: async (ctx, args) => {
  const owner = await requireMember(ctx, args.orgId, 'owner'), target = await ctx.db.get(args.memberId);
  if (!target || target.orgId !== args.orgId) fail('NOT_FOUND');
  if (!subset(args.scopes, target.readScopes) || target.hiddenFieldIds?.some(id => !args.hiddenFieldIds.includes(id))) {
    await writable(ctx, args.orgId);
    if (!unrestrictedHuman(owner)) fail('FORBIDDEN', 'Unrestricted owner required to increase human authority');
  }
  for (const id of args.hiddenFieldIds) if ((await ctx.db.get(id))?.orgId !== args.orgId) fail('NOT_FOUND');
  for (const scope of args.scopes ?? []) {
    if ((await ctx.db.get(scope.objectId))?.orgId !== args.orgId) fail('NOT_FOUND');
    for (const id of scope.fields === 'all' ? [] : scope.fields) if ((await ctx.db.get(id))?.objectId !== scope.objectId) fail('NOT_FOUND');
    for (const id of scope.records === 'all' ? [] : scope.records) if ((await ctx.db.get(id))?.objectId !== scope.objectId) fail('NOT_FOUND');
  }
  await ctx.db.patch(target._id, { readScopes: args.scopes, hiddenFieldIds: args.hiddenFieldIds, authorityEpoch: (target.authorityEpoch ?? 0) + 1 });
  await pauseWork(ctx, args.orgId);
  await ctx.db.insert('authorityAudit', { orgId: args.orgId, actor: owner.actor, action: 'memberScopeChanged', targetId: target._id, epoch: (target.authorityEpoch ?? 0) + 1 });
} });
export const setAgentMasks = mutation({ args: { orgId: v.id('orgs'), agentId: v.id('agents'), hiddenFieldIds: v.array(v.id('fields')) }, handler: async (ctx, args) => {
  const owner = await requireMember(ctx, args.orgId, 'owner'), agent = await ctx.db.get(args.agentId);
  if (!agent || agent.orgId !== args.orgId) fail('NOT_FOUND');
  if (agent.hiddenFieldIds?.some(id => !args.hiddenFieldIds.includes(id))) {
    await writable(ctx, args.orgId);
    if (!unrestrictedHuman(owner)) fail('FORBIDDEN', 'Unrestricted owner required to remove field restrictions');
  }
  for (const id of args.hiddenFieldIds) if ((await ctx.db.get(id))?.orgId !== args.orgId) fail('NOT_FOUND');
  await ctx.db.patch(agent._id, { hiddenFieldIds: args.hiddenFieldIds, authorityEpoch: (agent.authorityEpoch ?? 0) + 1 });
  await pauseWork(ctx, args.orgId);
  await ctx.db.insert('authorityAudit', { orgId: args.orgId, actor: owner.actor, action: 'agentMasksChanged', targetId: agent._id, epoch: (agent.authorityEpoch ?? 0) + 1 });
} });
