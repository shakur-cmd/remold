// Synthetic bulk data for ops/workspace/limits.mjs. Loaded only into the throwaway local backend, so its
// functions are public there: the script calls them over its client instead of the slower CLI.
import { mutation, query } from './_generated/server';
import { v } from 'convex/values';
import schema from './schema';
import { projections } from './lib/slots';

// Records with a create event each, as applyChange would write them, in bounded batches.
export const seed = mutation({ args: { orgId: v.id('orgs'), userId: v.id('users'), object: v.string(), start: v.number(), count: v.number(), text: v.number(), link: v.optional(v.id('records')) }, handler: async (ctx, args) => {
  const object = (await ctx.db.query('objects').withIndex('by_org_key', q => q.eq('orgId', args.orgId).eq('key', args.object)).unique())!;
  const fields = await ctx.db.query('fields').withIndex('by_object', q => q.eq('orgId', args.orgId).eq('objectId', object._id)).collect();
  const field = (key: string) => fields.find(f => f.key === key)!._id;
  const ids = [];
  for (let i = args.start; i < args.start + args.count; i++) {
    const values: Record<string, unknown> = { [field('name')]: `${args.object} ${i}`, ...(args.text ? { [field('notes')]: 'n'.repeat(args.text) } : {}), ...(args.link ? { [field('company')]: args.link } : {}) };
    const recordId = await ctx.db.insert('records', { orgId: args.orgId, objectId: object._id, values, title: `${args.object} ${i}`, createdBy: args.userId, updatedAt: Date.now(), ...projections(fields, values) });
    await ctx.db.insert('events', { orgId: args.orgId, actor: { kind: 'user', id: args.userId }, action: 'create', objectId: object._id, recordId, before: null, after: values });
    ids.push(recordId);
  }
  return ids;
} });
// Integration parents with no children: the shape that once stalled the purge.
export const parents = mutation({ args: { orgId: v.id('orgs'), count: v.number() }, handler: async (ctx, { orgId, count }) => {
  let binding = (await ctx.db.query('integrationBindings').withIndex('by_org', q => q.eq('orgId', orgId)).first())?._id;
  if (!binding) {
    const secret = await ctx.db.insert('secretReferences', { orgId, provider: 'sim', environment: 'test', account: `a${orgId}`, handle: 'h', version: 1, active: true });
    const connectionId = await ctx.db.insert('integrationConnections', { orgId, provider: 'sim', environment: 'test', account: `a${orgId}`, secretReferenceId: secret, credentialHash: `c${orgId}`, connected: true, healthy: true, version: 1 });
    binding = await ctx.db.insert('integrationBindings', { orgId, connectionId, provider: 'sim', environment: 'test', account: `a${orgId}`, kind: 'k', externalId: 'e', connected: true });
  }
  for (let i = 0; i < count; i++) await ctx.db.insert('safetyTargets', { orgId, bindingId: binding, documentRef: `d${i}`, providerRef: 'p', kind: 'payment', currency: 'usd', paidMinor: 0, refundedMinor: 0, pendingRefundMinor: 0, cancelled: false, generation: 0, startedAt: 0, complete: false, providerPendingMinor: 0 });
} });
// Which per-workspace tables still hold a row, read one row per table.
export const left = query({ args: { orgId: v.id('orgs') }, handler: async (ctx, { orgId }) => {
  const tables = Object.entries(schema.tables).filter(([, t]: any) => 'orgId' in t.validator.fields).map(([name]) => name);
  const out: string[] = (await ctx.db.get(orgId)) ? ['orgs'] : [];
  // Large tables through their orgId index; the small integration child tables by a scan.
  const indexed: Record<string, string> = { records: 'by_object', events: 'by_org', fields: 'by_object', objects: 'by_org', links: 'by_record_any', members: 'by_org_user', safetyTargets: 'by_org', integrationBindings: 'by_org', integrationConnections: 'by_org', authorityAudit: 'by_org', billingEvents: 'by_org', agents: 'by_org', invites: 'by_org' };
  for (const table of tables) {
    const query = ctx.db.query(table as any) as any;
    if (await (indexed[table] ? query.withIndex(indexed[table], (q: any) => q.eq('orgId', orgId)) : query.filter((q: any) => q.eq(q.field('orgId'), orgId))).first()) out.push(table);
  }
  return out;
} });
export const orgsNamed = query({ args: { name: v.string() }, handler: async (ctx, { name }) => (await ctx.db.query('orgs').collect()).filter(o => o.name === name).map(o => o._id) });
