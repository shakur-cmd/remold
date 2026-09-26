import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Principal } from '../identity';
import { fail } from '../errors';
import { epoch, principalFor, validGrants } from '../authority/grants';
import { canReadField, requireRecordRead } from '../authority/reads';
import { writable } from '../authority/readonly';
import { bound, usable } from './connections';
export type Ctx = QueryCtx | MutationCtx;
export type Operation = Doc<'integrationOps'>;
export const LIMITS = { leaseMs: 2000, permitMs: 1000, attempts: 3, steps: 5, consumed: 15 } as const;
export const sameActor = (a: Operation['actor'], b: Operation['actor']) => a.kind === b.kind && a.id === b.id;
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export async function ownOp(ctx: Ctx, principal: Principal, id: Id<'integrationOps'>) {
  const op = await ctx.db.get(id); if (!op || op.orgId !== principal.org._id) fail('NOT_FOUND', 'Operation not found'); return op;
}
export async function adapterOp(ctx: Ctx, credentialHash: string, id: Id<'integrationOps'>) {
  const op = await ctx.db.get(id); if (!op) fail('NOT_FOUND');
  if (op.safety) fail('FORBIDDEN', 'Human safety command requires its dedicated boundary');
  await bound(ctx, credentialHash, op.bindingId); return op;
}
export async function budgets(ctx: Ctx, orgId: Id<'orgs'>) {
  const [org, global] = await Promise.all([ctx.db.query('usageBudgets').withIndex('by_key', q => q.eq('key', orgId)).unique(), ctx.db.query('usageBudgets').withIndex('by_key', q => q.eq('key', 'global')).unique()]);
  if (!org || !global) fail('FORBIDDEN', 'Numeric budget missing; allowance is zero');
  return { org, global };
}
export function unresolved(op: Operation) { return op.absence?.finality !== 'final' && op.consumedPermits.some(p => !op.receipts.some(r => r.step === p.step)); }
export async function release(ctx: MutationCtx, operation: Operation) {
  const op = await ctx.db.get(operation._id);
  if (!op || op.released || unresolved(op) || op.receipts.some(r => r.usage === undefined)) return;
  if (op.reserved > 0) {
    const { org, global } = await budgets(ctx, op.orgId), remaining = Math.max(0, op.reserved - op.usage);
    for (const budget of [org, global]) await ctx.db.patch(budget._id, { reserved: budget.reserved - remaining, active: budget.active - 1 });
  }
  await ctx.db.patch(op._id, { released: true });
}
export async function event(ctx: MutationCtx, op: Operation, name: string, who: Doc<'integrationEvents'>['actor'], extra: { usageDelta?: number; usageKnown?: boolean } = {}) {
  const current = await ctx.db.get(op._id);
  await ctx.db.insert('integrationEvents', { orgId: op.orgId, operationId: op._id, bindingId: op.bindingId, actor: who, name, from: op.state, to: current?.state, step: current?.step ?? op.step, fence: current?.fence ?? op.fence, at: Date.now(), ...extra });
}
export async function anomaly(ctx: MutationCtx, op: Operation, reason: string) {
  const { org, global } = await budgets(ctx, op.orgId);
  await ctx.db.patch(op._id, { anomaly: reason }); await ctx.db.patch(org._id, { anomaly: reason });
  if (global.spent + global.reserved > global.cap) await ctx.db.patch(global._id, { anomaly: 'globalExposureExceeded' });
  await event(ctx, op, 'anomaly:' + reason, { kind: 'adapter', id: 'bound-adapter' });
}
export function matches(g: Doc<'capabilityGrants'>, op: Pick<Operation, 'bindingId' | 'payload' | 'reservationUnits' | 'maxSteps'>) {
  const s = g.scope;
  if (s.kind === 'bindings') return s.bindings.includes(op.bindingId) && s.currency === op.payload.currency && s.maxAmountMinor >= op.payload.amountMinor && s.maxRecipients >= op.payload.audience.length;
  return s.kind === 'model' && s.maxUnitsPerRun >= op.reservationUnits && s.maxSteps >= op.maxSteps;
}
export async function authority(ctx: Ctx, principal: Principal, op: Pick<Operation, 'bindingId' | 'payload' | 'reservationUnits' | 'maxSteps' | 'capability' | 'grantId'>) {
  if ('member' in principal) { if (principal.member.role === 'member') fail('FORBIDDEN', 'Admin authority required'); return undefined; }
  const candidates = (await validGrants(ctx, principal.agent, op.capability)).filter(g => (!op.grantId || g._id === op.grantId) && matches(g, op));
  const grant = candidates.find(g => g.mode === 'direct') ?? candidates[0]; if (!grant) fail('FORBIDDEN', 'External capability denied'); return grant;
}
export async function approveBindingRead(ctx: Ctx, principal: Principal, binding: Pick<Doc<'integrationBindings'>, 'localRecordId'>) {
  if (!binding.localRecordId) {
    if ('member' in principal && (principal.member.readScopes !== undefined || principal.member.hiddenFieldIds?.length)) fail('FORBIDDEN', 'Unstructured integration payload lacks a readable target');
    return;
  }
  const record = await ctx.db.get(binding.localRecordId), object = record ? await ctx.db.get(record.objectId) : null;
  if (!record || !object) fail('NOT_FOUND'); requireRecordRead(principal, object, record);
  const fields = await ctx.db.query('fields').withIndex('by_object', q => q.eq('orgId', principal.org._id).eq('objectId', object._id)).collect();
  if (fields.some(f => !canReadField(principal, object, f, record._id))) fail('FORBIDDEN', 'Approval needs access to the complete target');
}
export async function checked(ctx: Ctx, op: Operation) {
  if (op.cancelRequestedAt !== undefined || op.absence?.finality === 'final') fail('FORBIDDEN', 'Cancellation requested');
  const principal = await principalFor(ctx, op.orgId, op.actor); if (epoch(principal) !== op.actorEpoch || ('member' in principal && principal.member._id !== op.actorMembershipId)) fail('FORBIDDEN', 'Authority epoch changed');
  await writable(ctx, op.orgId);
  const binding = await ctx.db.get(op.bindingId), connection = binding ? await ctx.db.get(binding.connectionId) : null;
  if (!binding || !connection || binding.orgId !== op.orgId || !binding.connected || op.payload.destination !== binding.account) fail('FORBIDDEN', 'Binding unavailable');
  await usable(ctx, connection);
  const grant = await authority(ctx, principal, op), approval = op.approval;
  if (!approval || approval.expiresAt <= Date.now() || approval.version !== op.version || approval.actorEpoch !== op.actorEpoch || !same(approval.snapshot, op.payload)) fail('FORBIDDEN', 'Approval changed or expired');
  if ('grantId' in approval.approver) { if (!grant || grant._id !== approval.approver.grantId || grant.mode !== 'direct') fail('FORBIDDEN', 'Direct authority revoked'); }
  else {
    const approver = await principalFor(ctx, op.orgId, approval.approver);
    if (!('member' in approver) || approver.member.role === 'member' || epoch(approver) !== approval.approverEpoch || approver.member._id !== approval.approverMembershipId) fail('FORBIDDEN', 'Approver authority changed');
    await approveBindingRead(ctx, approver, binding);
  }
  const { org } = await budgets(ctx, op.orgId);
  if (op.payload.audience.length > org.maxRecipients || op.step > op.maxSteps || op.maxSteps > org.maxSteps) fail('FORBIDDEN', 'Exposure bounds exceeded');
  if (op.capability === 'marketing.send') for (const recipient of op.payload.audience) {
    const consent = await ctx.db.query('consent').withIndex('by_recipient', q => q.eq('orgId', op.orgId).eq('recipient', recipient).eq('channel', 'email').eq('purpose', 'marketing')).unique();
    if (!consent || consent.suppressed) fail('FORBIDDEN', 'Consent denied');
  }
  return { principal, grant, binding, connection };
}
