import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import type { Principal } from '../identity';
import { canReadRecordId, listedRecordIds } from './reads';
import { canSeeInbox, sharedInboxReader, unrestrictedHuman } from './inbox';

type Row = { _id: string; _creationTime: number };
type Stream<T> = { take(n: number): Promise<T[]>; collect(): Promise<T[]> };
// Merges index streams that each hold only rows the caller may see, in creation
// order. Nothing hidden is read, so neither the result nor its cost depends on
// items the caller cannot see. No limit means every visible row.
async function merge<T extends Row>(streams: Stream<T>[], order: 'asc' | 'desc', limit?: number): Promise<T[]> {
  const rows = (await Promise.all(streams.map(s => limit === undefined ? s.collect() : s.take(limit)))).flat();
  const unique = [...new Map(rows.map(r => [r._id, r])).values()].sort((a, b) => order === 'asc' ? a._creationTime - b._creationTime : b._creationTime - a._creationTime);
  return limit === undefined ? unique : unique.slice(0, limit);
}

// Suggestions with a status, newest first: per fully readable object, and per
// listed record for record-scoped objects. A caller who covers everything reads the
// org-wide index, which then holds nothing hidden.
export async function visibleSuggestions(ctx: QueryCtx, principal: Principal, status: Doc<'suggestions'>['status'], limit?: number): Promise<Doc<'suggestions'>[]> {
  const orgId = principal.org._id, objects = await ctx.db.query('objects').withIndex('by_org', q => q.eq('orgId', orgId)).collect();
  const streams: Stream<Doc<'suggestions'>>[] = []; let everything = true;
  for (const object of objects) {
    const ids = listedRecordIds(principal, object);
    if (ids === null) { streams.push(ctx.db.query('suggestions').withIndex('by_object_status', q => q.eq('orgId', orgId).eq('change.objectId', object._id).eq('status', status)).order('desc')); continue; }
    everything = false;
    for (const recordId of ids) streams.push(ctx.db.query('suggestions').withIndex('by_record', q => q.eq('orgId', orgId).eq('recordId', recordId)).order('desc').filter(q => q.eq(q.field('status'), status)));
  }
  if (everything) streams.splice(0, streams.length, ctx.db.query('suggestions').withIndex('by_org_status', q => q.eq('orgId', orgId).eq('status', status)).order('desc'));
  const byId = new Map(objects.map(o => [o._id, o]));
  return (await merge(streams, 'desc', limit)).filter(s => { const o = byId.get(s.change.objectId); return !!o && canReadRecordId(principal, o, s.change.recordId); });
}

// Inbox items with a status, oldest first: the caller's own items, plus shared items
// when the caller may read the shared inbox. An unrestricted human sees every item.
export async function visibleInboxItems(ctx: QueryCtx, principal: Principal, status: Doc<'agentInbox'>['status'], limit?: number): Promise<Doc<'agentInbox'>[]> {
  const orgId = principal.org._id, frozenAt = principal.org.authorityFrozenAt;
  const streams: Stream<Doc<'agentInbox'>>[] = [];
  if (unrestrictedHuman(principal)) streams.push(ctx.db.query('agentInbox').withIndex('by_org_status', q => q.eq('orgId', orgId).eq('status', status)).order('asc'));
  else {
    streams.push(ctx.db.query('agentInbox').withIndex('by_org_status_from', q => q.eq('orgId', orgId).eq('status', status).eq('from.kind', principal.actor.kind).eq('from.id', principal.actor.id)).order('asc'));
    if (sharedInboxReader(principal)) {
      streams.push(ctx.db.query('agentInbox').withIndex('by_org_status_audience', q => q.eq('orgId', orgId).eq('status', status).eq('audience', 'org')).order('asc'));
      // Items from before the audience field default to shared only if older than the freeze.
      if (frozenAt !== undefined) streams.push(ctx.db.query('agentInbox').withIndex('by_org_status_audience', q => q.eq('orgId', orgId).eq('status', status).eq('audience', undefined).lte('_creationTime', frozenAt)).order('asc'));
    }
  }
  return (await merge(streams, 'asc', limit)).filter(item => canSeeInbox(principal, item));
}
