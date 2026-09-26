import { mutation, internalMutation, query, internalQuery, type MutationCtx, type QueryCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { v } from 'convex/values';
import { payload, externalCapability } from '../../packages/contracts/integrations';
import { requireAgent, requireMember, type Principal } from '../identity';
import { epoch, principalFor } from '../authority/grants';
import { writable } from '../authority/readonly';
import { fail } from '../errors';
import { approveBindingRead, authority, budgets, checked, event, LIMITS, ownOp, release, same, sameActor, unresolved, type Operation } from './core';

const proposal = { logical: v.string(), bindingId: v.id('integrationBindings'), capability: externalCapability, payload, reservationUnits: v.number(), maxSteps: v.number() };
type Proposal = Pick<Operation, 'logical' | 'bindingId' | 'capability' | 'payload' | 'reservationUnits' | 'maxSteps'>;
function validate(args: Proposal) {
  if (!args.logical || args.logical.length > 200 || args.payload.content.length > 65536 || args.payload.audience.length > 100 || !Number.isSafeInteger(args.payload.amountMinor) || args.payload.amountMinor < 0 || !/^[A-Z]{3}$/.test(args.payload.currency) || !Number.isSafeInteger(args.reservationUnits) || args.reservationUnits <= 0 || !Number.isSafeInteger(args.maxSteps) || args.maxSteps < 1 || args.maxSteps > LIMITS.steps || (args.capability !== 'model.call' && args.maxSteps !== 1) || !Number.isFinite(args.payload.schedule) || args.payload.schedule < 0) fail('VALIDATION', 'Invalid bounded operation payload');
}
async function propose(ctx: MutationCtx, principal: Principal, args: Proposal, adopted?: Operation) {
  await writable(ctx, principal.org._id); validate(args);
  args = { logical: args.logical, bindingId: args.bindingId, capability: args.capability, payload: args.payload, reservationUnits: args.reservationUnits, maxSteps: args.maxSteps };
  const binding = await ctx.db.get(args.bindingId);
  if (!binding || binding.orgId !== principal.org._id) fail('NOT_FOUND');
  if (args.payload.destination !== binding.account) fail('FORBIDDEN', 'Destination substitution refused');
  if ('agent' in principal) await authority(ctx, principal, args);
  const prior = await ctx.db.query('integrationOps').withIndex('by_logical', q => q.eq('orgId', principal.org._id).eq('actor.id', principal.actor.id).eq('logical', args.logical)).unique();
  if (prior) {
    if (prior.bindingId !== args.bindingId || prior.capability !== args.capability || !same(prior.payload, args.payload) || prior.reservationUnits !== args.reservationUnits || prior.maxSteps !== args.maxSteps) fail('CONFLICT', 'Logical operation payload differs');
    return prior._id;
  }
  const id = await ctx.db.insert('integrationOps', { ...args, orgId: principal.org._id, actor: principal.actor, owner: principal.actor, author: adopted?.author ?? principal.actor, adoptedFrom: adopted?._id, actorEpoch: epoch(principal), actorMembershipId: 'member' in principal ? principal.member._id : undefined, version: 1, state: 'proposed', reserved: 0, usage: 0, usageMissing: false, step: 1, fence: 0, leaseUntil: 0, permitUntil: 0, permitUsed: false, attempts: 0, released: false, overrun: false, late: false, consumedPermits: [], receipts: [] });
  await event(ctx, (await ctx.db.get(id))!, adopted ? 'adopted' : 'proposed', principal.actor); return id;
}
export const proposeHuman = mutation({ args: { orgId: v.id('orgs'), ...proposal }, handler: async (ctx, args) => propose(ctx, await requireMember(ctx, args.orgId), args) });
export const proposeAgent = internalMutation({ args: { keyHash: v.string(), ...proposal }, handler: async (ctx, args) => propose(ctx, await requireAgent(ctx, args.keyHash), args) });
async function edit(ctx: MutationCtx, principal: Principal, id: Id<'integrationOps'>, next: Operation['payload']) {
  await writable(ctx, principal.org._id); const op = await ownOp(ctx, principal, id);
  if (!sameActor(op.actor, principal.actor) || !['proposed', 'approved'].includes(op.state) || op.reserved > 0) fail('FORBIDDEN', 'Operation cannot be edited');
  validate({ ...op, payload: next });
  const binding = await ctx.db.get(op.bindingId); if (!binding || binding.account !== next.destination) fail('FORBIDDEN', 'Destination substitution refused');
  await ctx.db.patch(id, { payload: next, version: op.version + 1, state: 'proposed', approval: undefined }); await event(ctx, op, 'payloadEdited', principal.actor);
}
export const editHuman = mutation({ args: { orgId: v.id('orgs'), id: v.id('integrationOps'), payload }, handler: async (ctx, args) => edit(ctx, await requireMember(ctx, args.orgId), args.id, args.payload) });
export const editAgent = internalMutation({ args: { keyHash: v.string(), id: v.id('integrationOps'), payload }, handler: async (ctx, args) => edit(ctx, await requireAgent(ctx, args.keyHash), args.id, args.payload) });
export const approve = mutation({ args: { orgId: v.id('orgs'), id: v.id('integrationOps'), expiresAt: v.number() }, handler: async (ctx, args) => {
  const human = await requireMember(ctx, args.orgId, 'admin'), op = await ownOp(ctx, human, args.id); await writable(ctx, args.orgId);
  if (!['proposed', 'approved'].includes(op.state) || op.cancelRequestedAt !== undefined) fail('FORBIDDEN', 'Operation cannot be approved');
  const actor = await principalFor(ctx, op.orgId, op.actor), binding = await ctx.db.get(op.bindingId);
  if (!binding || epoch(actor) !== op.actorEpoch || ('member' in actor && actor.member._id !== op.actorMembershipId)) fail('FORBIDDEN', 'Actor changed; adopt as a new action');
  await approveBindingRead(ctx, human, binding);
  if (!Number.isFinite(args.expiresAt)) fail('VALIDATION');
  await ctx.db.patch(op._id, { state: 'approved', approval: { snapshot: op.payload, version: op.version, actorEpoch: op.actorEpoch, expiresAt: args.expiresAt, approver: human.actor, approverEpoch: epoch(human), approverMembershipId: human.member._id } });
  await event(ctx, op, 'approved', human.actor);
} });
async function claim(ctx: MutationCtx, principal: Principal, id: Id<'integrationOps'>, worker: string) {
  let op = await ownOp(ctx, principal, id);
  if (op.safety) fail('FORBIDDEN', 'Use signed-in human safety consume');
  if (op.released || op.cancelRequestedAt !== undefined || op.absence?.finality === 'final') fail('FORBIDDEN', 'Operation stopped');
  if (!sameActor(op.actor, principal.actor) || !sameActor(op.owner, principal.actor) || !['proposed', 'approved', 'queued'].includes(op.state) || op.leaseUntil > Date.now()) fail('FORBIDDEN', 'Not claimable');
  if (!worker || worker.length > 100) fail('VALIDATION', 'Worker identity required');
  const grant = await authority(ctx, principal, op);
  if (op.state === 'proposed' && grant?.mode === 'direct') {
    const approval = { snapshot: op.payload, version: op.version, actorEpoch: op.actorEpoch, expiresAt: grant.expiresAt, approver: { grantId: grant._id } };
    await ctx.db.patch(op._id, { approval, state: 'approved', grantId: grant._id }); op = { ...op, approval, state: 'approved', grantId: grant._id };
  }
  const valid = await checked(ctx, op), { org, global } = await budgets(ctx, op.orgId);
  if (org.anomaly || global.anomaly || org.missingUsage) fail('FORBIDDEN', 'Unresolved usage or operator anomaly hold');
  if (op.reservationUnits > org.maxPerRun || op.reservationUnits > global.maxPerRun) fail('FORBIDDEN', 'Per-run budget cap');
  if (op.reserved === 0) {
    for (const budget of [org, global]) {
      if (budget.active >= budget.maxConcurrent || budget.spent + budget.reserved + op.reservationUnits > budget.cap) fail('FORBIDDEN', 'Budget or concurrency cap');
      await ctx.db.patch(budget._id, { reserved: budget.reserved + op.reservationUnits, active: budget.active + 1 });
    }
  }
  const fence = op.fence + 1;
  await ctx.db.patch(id, { state: 'queued', grantId: valid.grant?._id, reserved: op.reservationUnits, fence, worker, leaseUntil: Date.now() + LIMITS.leaseMs });
  await event(ctx, op, 'claimed', principal.actor); return { fence, step: op.step };
}
export const claimHuman = mutation({ args: { orgId: v.id('orgs'), id: v.id('integrationOps'), worker: v.string() }, handler: async (ctx, args) => claim(ctx, await requireMember(ctx, args.orgId), args.id, args.worker) });
export const claimAgent = internalMutation({ args: { keyHash: v.string(), id: v.id('integrationOps'), worker: v.string() }, handler: async (ctx, args) => claim(ctx, await requireAgent(ctx, args.keyHash), args.id, args.worker) });
async function cancel(ctx: MutationCtx, principal: Principal, id: Id<'integrationOps'>) {
  const op = await ownOp(ctx, principal, id);
  if (!sameActor(op.owner, principal.actor) && (!('member' in principal) || principal.member.role === 'member')) fail('FORBIDDEN');
  if (op.cancelRequestedAt !== undefined) return;
  const inflight = ['dispatching', 'cancellationPending'].includes(op.state), pending = unresolved(op);
  const state = op.state === 'confirmed' ? 'confirmed' : ['refused', 'cancelled'].includes(op.state) ? op.state : inflight ? 'cancellationPending' : op.state === 'outcomeUnknown' || pending ? 'outcomeUnknown' : 'cancelled';
  await ctx.db.patch(id, { state, cancelRequestedAt: Date.now() }); if (!inflight && !pending) await release(ctx, op);
  await event(ctx, op, 'cancellationRequested', principal.actor);
}
export const cancelHuman = mutation({ args: { orgId: v.id('orgs'), id: v.id('integrationOps') }, handler: async (ctx, args) => cancel(ctx, await requireMember(ctx, args.orgId), args.id) });
export const cancelAgent = internalMutation({ args: { keyHash: v.string(), id: v.id('integrationOps') }, handler: async (ctx, args) => cancel(ctx, await requireAgent(ctx, args.keyHash), args.id) });
export const adopt = mutation({ args: { orgId: v.id('orgs'), id: v.id('integrationOps'), logical: v.string() }, handler: async (ctx, args) => {
  const human = await requireMember(ctx, args.orgId, 'admin'), source = await ownOp(ctx, human, args.id);
  if (!['proposed', 'paused'].includes(source.state)) fail('FORBIDDEN', 'Only unpublished work can be adopted');
  const binding = await ctx.db.get(source.bindingId); if (!binding) fail('NOT_FOUND'); await approveBindingRead(ctx, human, binding);
  return propose(ctx, human, { logical: args.logical, bindingId: source.bindingId, capability: source.capability, payload: source.payload, reservationUnits: source.reservationUnits, maxSteps: source.maxSteps }, source);
} });
async function get(ctx: QueryCtx, principal: Principal, id: Id<'integrationOps'>) {
  const op = await ownOp(ctx, principal, id);
  if ('agent' in principal) { if (!sameActor(op.actor, principal.actor)) fail('NOT_FOUND'); return { id: op._id, state: op.state, step: op.step, fence: op.fence, owner: op.owner, author: op.author, cancelRequested: op.cancelRequestedAt !== undefined, late: op.late, usage: op.usageMissing ? null : op.usage }; }
  if (principal.member.role === 'member' && !sameActor(op.actor, principal.actor)) fail('NOT_FOUND');
  const binding = await ctx.db.get(op.bindingId); let full = false;
  try { if (binding) { await approveBindingRead(ctx, principal, binding); full = principal.member.role !== 'member'; } } catch { /* Unstructured payloads cannot be field-projected safely. */ }
  if (full) return op;
  return { id: op._id, state: op.state, step: op.step, owner: op.owner, author: op.author, cancelRequested: op.cancelRequestedAt !== undefined, late: op.late };
}
export const getHuman = query({ args: { orgId: v.id('orgs'), id: v.id('integrationOps') }, handler: async (ctx, args) => get(ctx, await requireMember(ctx, args.orgId), args.id) });
export const getAgent = internalQuery({ args: { keyHash: v.string(), id: v.id('integrationOps') }, handler: async (ctx, args) => get(ctx, await requireAgent(ctx, args.keyHash), args.id) });
