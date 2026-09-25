import { pauseWork } from '../integrations/lifecycle';
import { mutation, internalMutation, type QueryCtx, type MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { v } from 'convex/values';
import { capability, capabilityScope, within, type Actor, type Capability } from '../../packages/contracts/authority';
import { requireAgent, requireMember, type Principal } from '../identity';
import { fail } from '../errors';
import { canReadField, canReadRecord, scopes } from './reads';
import { approveBindingRead } from '../integrations/core';
import { writable } from './readonly';

type Ctx = QueryCtx | MutationCtx;
export const epoch = (p: Principal) => 'agent' in p ? p.agent.authorityEpoch ?? 0 : p.member.authorityEpoch ?? 0;
export async function principalFor(ctx: Ctx, orgId: Id<'orgs'>, actor: Actor): Promise<Principal> {
  const org = await ctx.db.get(orgId); if (!org) fail('NOT_FOUND');
  if (actor.kind === 'agent') {
    const id = ctx.db.normalizeId('agents', actor.id), agent = id ? await ctx.db.get(id) : null;
    if (!agent || agent.orgId !== orgId || agent.revokedAt !== undefined || (agent.state !== undefined && agent.state !== 'active')) fail('FORBIDDEN', 'Agent inactive');
    return { agent, org, actor: { kind: 'agent', id: agent._id } };
  }
  const id = ctx.db.normalizeId('users', actor.id), user = id ? await ctx.db.get(id) : null;
  const member = user ? await ctx.db.query('members').withIndex('by_org_user', q => q.eq('orgId', orgId).eq('userId', user._id)).unique() : null;
  if (!user || !member) fail('FORBIDDEN', 'Membership required');
  return { user, member, org, actor: { kind: 'user', id: user._id } };
}
export async function liveGrant(ctx: Ctx, id: Id<'capabilityGrants'>, seen: Id<'capabilityGrants'>[] = []): Promise<Doc<'capabilityGrants'>> {
  if (seen.includes(id) || seen.length >= 8) fail('FORBIDDEN', 'Grant ancestry depth or cycle');
  const g = await ctx.db.get(id);
  if (!g || g.revokedAt !== undefined || g.expiresAt <= Date.now()) fail('FORBIDDEN', 'Grant expired or revoked');
  const giver = await principalFor(ctx, g.orgId, g.grantor);
  await principalFor(ctx, g.orgId, { kind: 'agent', id: g.agentId });
  if (epoch(giver) !== g.grantorEpoch || ('member' in giver && giver.member._id !== g.grantorMembershipId)) fail('FORBIDDEN', 'Grant ancestry changed');
  if (g.parent) {
    const parent = await liveGrant(ctx, g.parent, [...seen, id]);
    if (g.grantor.kind !== 'agent' || parent.agentId !== g.grantor.id || parent.orgId !== g.orgId || !parent.delegate || parent.capability !== g.capability || g.expiresAt > parent.expiresAt || (g.mode === 'direct' && parent.mode !== 'direct') || !within(g.scope, parent.scope)) fail('FORBIDDEN', 'Delegation exceeds parent');
  } else if (!('member' in giver) || giver.member.role !== 'owner') fail('FORBIDDEN', 'Human owner root required');
  return g;
}
export async function validGrants(ctx: Ctx, agent: Doc<'agents'>, cap?: Capability) {
  const candidates = cap ? await ctx.db.query('capabilityGrants').withIndex('by_agent_capability', q => q.eq('orgId', agent.orgId).eq('agentId', agent._id).eq('capability', cap)).collect() : await ctx.db.query('capabilityGrants').withIndex('by_agent', q => q.eq('orgId', agent.orgId).eq('agentId', agent._id)).collect();
  const result: Doc<'capabilityGrants'>[] = [];
  for (const g of candidates) { try { result.push(await liveGrant(ctx, g._id)); } catch { /* Revoked ancestry confers no rights. */ } }
  return result;
}
export async function manage(ctx: Ctx, principal: Principal, target: Id<'agents'>) {
  const agent = await ctx.db.get(target);
  if (!agent || agent.orgId !== principal.org._id) fail('NOT_FOUND');
  if ('member' in principal) { if (principal.member.role !== 'owner') fail('FORBIDDEN', 'Owner required'); return; }
  if (principal.agent._id === target) fail('FORBIDDEN', 'Cannot manage self');
  for (const initial of await ctx.db.query('capabilityGrants').withIndex('by_agent', q => q.eq('orgId', principal.org._id).eq('agentId', principal.agent._id)).collect()) {
    let grant: Doc<'capabilityGrants'> | null = initial;
    const seen = new Set<string>();
    while (grant) {
      if (seen.has(grant._id) || seen.size >= 8) fail('FORBIDDEN', 'Grant ancestry depth or cycle'); seen.add(grant._id);
      if (grant.grantor.kind === 'agent' && grant.grantor.id === target) fail('FORBIDDEN', 'Cannot manage an ancestor');
      grant = grant.parent ? await ctx.db.get(grant.parent) : null;
    }
  }
  if (!(await validGrants(ctx, principal.agent, 'agent.manage')).some(g => g.scope.kind === 'agents' && g.scope.agents.includes(target))) fail('FORBIDDEN', 'Outside managed subtree');
}
const grantArgs = { target: v.id('agents'), capability, scope: capabilityScope, mode: v.union(v.literal('propose'), v.literal('direct')), delegate: v.boolean(), expiresAt: v.number(), parent: v.optional(v.id('capabilityGrants')) };
type GrantInput = { target: Id<'agents'>; capability: Capability; scope: Doc<'capabilityGrants'>['scope']; mode: 'direct' | 'propose'; delegate: boolean; expiresAt: number; parent?: Id<'capabilityGrants'> };
async function issue(ctx: MutationCtx, principal: Principal, args: GrantInput) {
  await writable(ctx, principal.org._id);
  await manage(ctx, principal, args.target);
  if (!Number.isFinite(args.expiresAt) || args.expiresAt <= Date.now()) fail('VALIDATION', 'Grant must expire in the future');
  const s = args.scope;
  if (s.kind === 'records') {
    if (!['read', 'propose', 'record.create', 'record.update', 'record.delete'].includes(args.capability) || (await ctx.db.get(s.objectId))?.orgId !== principal.org._id) fail('VALIDATION', 'Record scope mismatch');
    const object = (await ctx.db.get(s.objectId))!, fields = await Promise.all(s.fields.map(id => ctx.db.get(id)));
    if (fields.some(field => !field || field.objectId !== object._id)) fail('NOT_FOUND', 'Field not found');
    if (s.records === 'all') {
      const all = scopes(principal, object).filter(scope => scope.records === 'all');
      if (!all.length || fields.some(field => !canReadField(principal, object, field!) || !all.some(scope => scope.fields === 'all' || scope.fields.includes(field!._id)))) fail('FORBIDDEN', 'Grant exceeds current data scope');
    } else for (const id of s.records) {
      const record = await ctx.db.get(id);
      if (!record || record.objectId !== object._id) fail('NOT_FOUND', 'Record not found');
      if (!canReadRecord(principal, object, record) || fields.some(field => !canReadField(principal, object, field!, record._id))) fail('FORBIDDEN', 'Grant exceeds current data scope');
    }
  } else if (s.kind === 'agents') {
    if (args.capability !== 'agent.manage') fail('VALIDATION', 'Manage scope mismatch');
    for (const id of s.agents) if ((await ctx.db.get(id))?.orgId !== principal.org._id) fail('NOT_FOUND');
  } else if (s.kind === 'model') {
    if (args.capability !== 'model.call' || !Number.isSafeInteger(s.maxUnitsPerRun) || s.maxUnitsPerRun <= 0 || !Number.isSafeInteger(s.maxSteps) || s.maxSteps <= 0) fail('VALIDATION', 'Model limits required');
  } else {
    if (!['marketing.send', 'social.publish', 'billing.issue', 'billing.collect', 'billing.refund', 'billing.cancelRecurring'].includes(args.capability) || !Number.isSafeInteger(s.maxAmountMinor) || s.maxAmountMinor < 0 || !/^[A-Z]{3}$/.test(s.currency) || !Number.isSafeInteger(s.maxRecipients) || s.maxRecipients <= 0) fail('VALIDATION', 'Binding limits required');
    for (const id of s.bindings) { const binding = await ctx.db.get(id); if (!binding || binding.orgId !== principal.org._id) fail('NOT_FOUND'); if ('member' in principal) await approveBindingRead(ctx, principal, binding); }
  }
  if ('agent' in principal) {
    if (!args.parent) fail('FORBIDDEN', 'Delegation parent required');
    const p = await liveGrant(ctx, args.parent);
    if (p.agentId !== principal.agent._id || !p.delegate || p.capability !== args.capability || !within(s, p.scope) || args.expiresAt > p.expiresAt || (args.mode === 'direct' && p.mode !== 'direct')) fail('FORBIDDEN', 'Delegation exceeds parent');
  } else if (args.parent) fail('VALIDATION', 'Human grants are independent roots');
  const id = await ctx.db.insert('capabilityGrants', { orgId: principal.org._id, agentId: args.target, grantor: principal.actor, grantorEpoch: epoch(principal), grantorMembershipId: 'member' in principal ? principal.member._id : undefined, capability: args.capability, scope: s, mode: args.mode, delegate: args.delegate, expiresAt: args.expiresAt, parent: args.parent });
  await ctx.db.insert('authorityAudit', { orgId: principal.org._id, actor: principal.actor, action: 'capabilityGranted', targetId: id, epoch: epoch(principal) });
  return id;
}
export const grant = mutation({ args: { orgId: v.id('orgs'), ...grantArgs }, handler: async (ctx, args) => issue(ctx, await requireMember(ctx, args.orgId, 'owner'), args) });
export const grantAgent = internalMutation({ args: { keyHash: v.string(), ...grantArgs }, handler: async (ctx, args) => issue(ctx, await requireAgent(ctx, args.keyHash), args) });
async function revokeGrant(ctx: MutationCtx, principal: Principal, id: Id<'capabilityGrants'>) {
  const g = await ctx.db.get(id); if (!g || g.orgId !== principal.org._id) fail('NOT_FOUND');
  await manage(ctx, principal, g.agentId);
  if ('agent' in principal && (g.grantor.kind !== 'agent' || g.grantor.id !== principal.agent._id)) fail('FORBIDDEN', 'Only own delegation may be revoked');
  if (g.revokedAt !== undefined) return;
  await ctx.db.patch(id, { revokedAt: Date.now() });
  const target = await ctx.db.get(g.agentId); if (!target) fail('NOT_FOUND');
  await ctx.db.patch(target._id, { authorityEpoch: (target.authorityEpoch ?? 0) + 1 });
  await pauseWork(ctx, principal.org._id);
  await ctx.db.insert('authorityAudit', { orgId: principal.org._id, actor: principal.actor, action: 'capabilityRevoked', targetId: id, epoch: (target.authorityEpoch ?? 0) + 1 });
}
export const revoke = mutation({ args: { orgId: v.id('orgs'), id: v.id('capabilityGrants') }, handler: async (ctx, args) => revokeGrant(ctx, await requireMember(ctx, args.orgId, 'owner'), args.id) });
export const revokeAgent = internalMutation({ args: { keyHash: v.string(), id: v.id('capabilityGrants') }, handler: async (ctx, args) => revokeGrant(ctx, await requireAgent(ctx, args.keyHash), args.id) });
export const fireAgent = internalMutation({ args: { keyHash: v.string(), target: v.id('agents') }, handler: async (ctx, args) => {
  const principal = await requireAgent(ctx, args.keyHash); await manage(ctx, principal, args.target);
  const target = await ctx.db.get(args.target); if (!target) fail('NOT_FOUND');
  if (target.state === 'fired') return;
  await ctx.db.patch(target._id, { state: 'fired', revokedAt: Date.now(), authorityEpoch: (target.authorityEpoch ?? 0) + 1 });
  await pauseWork(ctx, principal.org._id);
  await ctx.db.insert('authorityAudit', { orgId: principal.org._id, actor: principal.actor, action: 'agentFired', targetId: target._id, epoch: (target.authorityEpoch ?? 0) + 1 });
} });
