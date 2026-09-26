import { internalAction, internalMutation, type MutationCtx } from '../_generated/server';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import type { Doc } from '../_generated/dataModel';
import { fail } from '../errors';
import { adapter, bound } from './connections';
const observation = v.object({ version: v.number(), state: v.string(), channel: v.optional(v.string()), purpose: v.optional(v.string()) });
type Observation = { version: number; state: string; channel?: string; purpose?: string };
function validate(input: Observation) {
  if (!Number.isSafeInteger(input.version) || input.version < 0 || !input.state || input.state.length > 80) fail('VALIDATION', 'Invalid provider observation');
  if (input.state === 'suppressed' && (!input.channel || !input.purpose || input.channel.length > 80 || input.purpose.length > 80)) fail('VALIDATION', 'Suppression channel and purpose required');
}
async function observe(ctx: MutationCtx, binding: Doc<'integrationBindings'>, input: Observation) {
  validate(input);
  const prior = await ctx.db.query('integrationObservations').withIndex('by_binding', q => q.eq('bindingId', binding._id)).unique();
  if (prior && input.version <= prior.version) return;
  const row = { version: input.version, state: input.state, observedAt: Date.now() };
  if (prior) await ctx.db.patch(prior._id, row); else await ctx.db.insert('integrationObservations', { orgId: binding.orgId, bindingId: binding._id, ...row });
  if (input.state === 'suppressed') {
    if (!binding.recipient) fail('VALIDATION', 'Recipient binding required');
    const channel = input.channel!, purpose = input.purpose!;
    const consent = await ctx.db.query('consent').withIndex('by_recipient', q => q.eq('orgId', binding.orgId).eq('recipient', binding.recipient!).eq('channel', channel).eq('purpose', purpose)).unique();
    const update = { suppressed: true, version: (consent?.version ?? 0) + 1, source: binding.provider + ':' + binding._id, at: Date.now() };
    if (consent) await ctx.db.patch(consent._id, update); else await ctx.db.insert('consent', { orgId: binding.orgId, recipient: binding.recipient, channel, purpose, ...update });
  }
}
const callbackArgs = { credentialHash: v.string(), bindingId: v.id('integrationBindings'), eventId: v.string(), body: v.string() };
export const callback = internalAction({ args: callbackArgs, handler: async (ctx, args): Promise<string> => {
  if (args.body.length > 16384) fail('VALIDATION');
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(args.body)))].map(b => b.toString(16).padStart(2, '0')).join('');
  return ctx.runMutation(makeFunctionReference<'mutation'>('integrations/callbacks:receive'), { ...args, digest });
} });
export const receive = internalMutation({ args: { ...callbackArgs, digest: v.string() }, handler: async (ctx, args) => {
  const { binding, connection } = await bound(ctx, args.credentialHash, args.bindingId);
  if (!args.eventId || args.eventId.length > 300 || args.body.length > 16384) fail('VALIDATION');
  let parsed: unknown; try { parsed = JSON.parse(args.body); } catch { fail('VALIDATION', 'Invalid callback body'); }
  if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || !('state' in parsed) || typeof parsed.version !== 'number' || typeof parsed.state !== 'string' || ('channel' in parsed && typeof parsed.channel !== 'string') || ('purpose' in parsed && typeof parsed.purpose !== 'string')) fail('VALIDATION');
  const input = parsed as Observation; validate(input);
  const digest = args.digest;
  const prior = await ctx.db.query('integrationCallbacks').withIndex('by_event', q => q.eq('bindingId', binding._id).eq('eventId', args.eventId)).unique();
  if (prior) { if (prior.digest !== digest) fail('CONFLICT', 'Callback integrity mismatch'); return 'duplicate'; }
  await ctx.db.insert('integrationCallbacks', { orgId: binding.orgId, bindingId: binding._id, eventId: args.eventId, digest, receivedAt: Date.now() });
  await observe(ctx, binding, input);
  await ctx.db.insert('integrationEvents', { orgId: binding.orgId, bindingId: binding._id, actor: { kind: 'adapter', id: connection._id }, name: 'providerObserved', at: Date.now() }); return 'applied';
} });
export const page = internalMutation({ args: { credentialHash: v.string(), resource: v.string(), traversal: v.string(), from: v.number(), page: v.number(), items: v.array(v.object({ bindingId: v.id('integrationBindings'), observation })), end: v.boolean(), checkpoint: v.number() }, handler: async (ctx, args) => {
  const connection = await adapter(ctx, args.credentialHash);
  if (!args.resource || args.resource.length > 80 || !args.traversal || args.traversal.length > 200 || !Number.isSafeInteger(args.page) || args.page < 1 || !Number.isSafeInteger(args.from) || args.from < 0 || !Number.isSafeInteger(args.checkpoint) || args.items.length > 100) fail('VALIDATION');
  let cursor = await ctx.db.query('integrationCursors').withIndex('by_resource', q => q.eq('connectionId', connection._id).eq('resource', args.resource)).unique();
  if (!cursor) {
    if (args.from !== 0 || args.page !== 1) fail('CONFLICT', 'Initial checkpoint mismatch');
    const id = await ctx.db.insert('integrationCursors', { orgId: connection.orgId, connectionId: connection._id, resource: args.resource, checkpoint: 0, traversal: args.traversal, nextPage: 1, complete: false }); cursor = (await ctx.db.get(id))!;
  }
  const digest = JSON.stringify({ items: args.items, from: args.from, end: args.end, checkpoint: args.checkpoint });
  const previousPage = await ctx.db.query('integrationPages').withIndex('by_page', q => q.eq('cursorId', cursor!._id).eq('traversal', args.traversal).eq('page', args.page)).unique();
  if (previousPage) { if (previousPage.digest !== digest) fail('CONFLICT', 'Repeated page differs'); return cursor.checkpoint; }
  if (cursor.traversal !== args.traversal) {
    if (!cursor.complete || args.from !== cursor.checkpoint || args.page !== 1) fail('CONFLICT', 'Traversal checkpoint mismatch');
    cursor = { ...cursor, traversal: args.traversal, nextPage: 1, complete: false };
  }
  if (cursor.complete || args.from !== cursor.checkpoint || args.page !== cursor.nextPage || args.checkpoint < cursor.checkpoint) fail('CONFLICT', 'Partial traversal gap or regression');
  for (const item of args.items) { const { binding } = await bound(ctx, args.credentialHash, item.bindingId); await observe(ctx, binding, item.observation); }
  await ctx.db.insert('integrationPages', { cursorId: cursor._id, traversal: args.traversal, page: args.page, digest });
  const checkpoint = args.end ? args.checkpoint : cursor.checkpoint;
  await ctx.db.patch(cursor._id, { traversal: args.traversal, nextPage: args.page + 1, checkpoint, complete: args.end }); return checkpoint;
} });
