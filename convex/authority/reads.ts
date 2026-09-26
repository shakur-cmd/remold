import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Principal } from '../identity';
import type { RecordScope } from '../../packages/contracts/authority';
import { fail } from '../errors';
import { compareValues, type Value } from 'convex/values';

type Ctx = QueryCtx | MutationCtx;
export function scopes(principal: Principal, object: Doc<'objects'>): RecordScope[] {
  if (object.orgId !== principal.org._id) return [];
  if ('member' in principal) return principal.member.readScopes?.filter(s => s.objectId === object._id) ?? [{ objectId: object._id, records: 'all', fields: 'all' }];
  const a = principal.agent, allowed = a.authorityVersion === 1 ? a.readObjectIds?.includes(object._id) : principal.org.authorityFrozenAt !== undefined && object._creationTime <= principal.org.authorityFrozenAt;
  const granted: RecordScope[] = (principal.capabilities ?? []).filter(g => g.capability === 'read' && g.scope.kind === 'records' && g.scope.objectId === object._id).flatMap(g => g.scope.kind === 'records' ? [{ objectId: g.scope.objectId, records: g.scope.records, fields: g.scope.fields }] : []);
  return [...(allowed ? [{ objectId: object._id, records: 'all' as const, fields: 'all' as const }] : []), ...granted];
}
// Filters while collecting. Taking the first N rows and filtering afterwards lets
// hidden rows push a caller's own matches out of the result, which reveals that
// the hidden rows exist. scanCap bounds the reads.
export async function firstVisible<T, R>(rows: AsyncIterable<T>, limit: number, keep: (row: T) => Promise<R | null | undefined | false> | R | null | undefined | false, scanCap = 1000): Promise<R[]> {
  const out: R[] = []; let scanned = 0;
  if (limit <= 0) return out;
  for await (const row of rows) { const kept = await keep(row); if (kept) out.push(kept); if (out.length >= limit || ++scanned >= scanCap) break; }
  return out;
}
// Record-scoped readers. When no scope a caller holds on an object covers all of
// its records, answer from the caller's explicit record list instead of the
// object's index. Page sizes, done flags, cursors, scan limits and timing then
// depend only on rows the caller can read. Returns null when some scope covers
// every record: a per-object index then holds no row the caller cannot read.
export function listedRecordIds(principal: Principal, object: Doc<'objects'>): Id<'records'>[] | null {
  const all = scopes(principal, object);
  if (all.some(s => s.records === 'all')) return null;
  return [...new Set(all.flatMap(s => s.records === 'all' ? [] : s.records))];
}
export async function listedRecords(ctx: Ctx, principal: Principal, object: Doc<'objects'>): Promise<Doc<'records'>[] | null> {
  const ids = listedRecordIds(principal, object);
  if (!ids) return null;
  const rows = await Promise.all(ids.map(id => ctx.db.get(id)));
  return rows.filter((r): r is Doc<'records'> => !!r && canReadRecord(principal, object, r));
}
// Convex's own index ordering (strings by UTF-8 bytes, -0 before 0), so the list path
// sorts and filters exactly like the index path would.
export function compareIndexValues(a: unknown, b: unknown) { return compareValues(a as Value | undefined, b as Value | undefined); }
// Offset pagination over an in-memory list, shaped like Convex's paginate result.
// Paginates an index query. Our own cursor formats, or any cursor Convex cannot parse,
// get a clean refusal instead of a raw server error.
export async function paginateIndex<T = any>(query: { paginate(opts: any): Promise<T> }, opts: { cursor: string | null; numItems: number; endCursor?: string | null }) {
  if ([opts.cursor, opts.endCursor].some(c => typeof c === 'string' && /^(list|events):/.test(c))) fail('VALIDATION', 'Invalid cursor');
  try { return await query.paginate(opts); } catch (error) { if (/cursor/i.test(String((error as Error)?.message ?? error))) fail('VALIDATION', 'Invalid cursor'); throw error; }
}
export function pageList<T>(rows: T[], opts: { cursor: string | null; numItems: number; endCursor?: string | null }) {
  const at = (cursor: string) => { const m = /^list:(\d+)$/.exec(cursor); if (!m) fail('VALIDATION', 'Invalid cursor'); return Number(m[1]); };
  const start = opts.cursor ? at(opts.cursor) : 0, end = opts.endCursor ? at(opts.endCursor) : start + Math.max(0, Math.floor(opts.numItems));
  return { page: rows.slice(start, end), isDone: end >= rows.length, continueCursor: 'list:' + end };
}
export function canReadObject(principal: Principal, object: Doc<'objects'>) { return scopes(principal, object).length > 0; }
export function canReadRecordId(principal: Principal, object: Doc<'objects'>, recordId?: Id<'records'>) {
  return scopes(principal, object).some(s => s.records === 'all' || (recordId !== undefined && s.records.includes(recordId)));
}
export function canReadRecord(principal: Principal, object: Doc<'objects'>, record: Doc<'records'>) {
  return record.orgId === principal.org._id && record.objectId === object._id && canReadRecordId(principal, object, record._id);
}
export function canReadField(principal: Principal, object: Doc<'objects'>, field: Doc<'fields'>, recordId?: Id<'records'>) {
  const hidden = 'member' in principal ? principal.member.hiddenFieldIds : principal.agent.hiddenFieldIds;
  return field.orgId === principal.org._id && field.objectId === object._id && !hidden?.includes(field._id) && scopes(principal, object).some(s => (!recordId || s.records === 'all' || s.records.includes(recordId)) && (s.fields === 'all' || s.fields.includes(field._id)));
}
export function requireObjectRead(principal: Principal, object: Doc<'objects'>) { if (!canReadObject(principal, object)) fail('NOT_FOUND', 'Object not found'); }
export async function requireObjectAdministration(ctx: Ctx, principal: Principal, object: Doc<'objects'>) {
  const all = scopes(principal, object).filter(s => s.records === 'all');
  const fields = await ctx.db.query('fields').withIndex('by_object', q => q.eq('orgId', principal.org._id).eq('objectId', object._id)).collect();
  if (!all.length || fields.some(f => !canReadField(principal, object, f) || !all.some(s => s.fields === 'all' || s.fields.includes(f._id)))) fail('FORBIDDEN', 'Full object scope required for metadata changes');
}
export function requireRecordRead(principal: Principal, object: Doc<'objects'>, record: Doc<'records'>) { if (!canReadRecord(principal, object, record)) fail('NOT_FOUND', 'Record not found'); }
// A field every scope on the object covers, so filtering, sorting or matching on it
// treats every readable record the same way.
export function canQueryField(principal: Principal, object: Doc<'objects'>, field: Doc<'fields'>) {
  return canReadField(principal, object, field) && scopes(principal, object).every(s => s.fields === 'all' || s.fields.includes(field._id));
}
export function requireQueryField(principal: Principal, object: Doc<'objects'>, field: Doc<'fields'>) {
  if (!canQueryField(principal, object, field)) fail('NOT_FOUND', 'Field not found');
}
export async function visibleTitle(ctx: Ctx, principal: Principal, record: Doc<'records'>, depth = 0): Promise<string> {
  const object = await ctx.db.get(record.objectId);
  if (!object || !canReadRecord(principal, object, record) || !object.titleFieldId || depth > 5) return '';
  const field = await ctx.db.get(object.titleFieldId);
  if (!field || !canReadField(principal, object, field, record._id)) return '';
  if (field.type === 'lookup') {
    const id = ctx.db.normalizeId('records', String(record.values[field._id] ?? ''));
    const target = id ? await ctx.db.get(id) : null;
    return target ? visibleTitle(ctx, principal, target, depth + 1) : '';
  }
  return record.title;
}
export async function projectRecord(ctx: Ctx, principal: Principal, record: Doc<'records'>): Promise<Doc<'records'> | null> {
  const object = await ctx.db.get(record.objectId);
  if (!object || !canReadRecord(principal, object, record)) return null;
  const fields = await ctx.db.query('fields').withIndex('by_object', q => q.eq('orgId', principal.org._id).eq('objectId', object._id)).collect();
  const values = Object.fromEntries(fields.filter(f => canReadField(principal, object, f, record._id) && f._id in record.values).map(f => [f._id, record.values[f._id]]));
  // Slot projections duplicate canonical values; omit all slots from read DTOs.
  const { _id, _creationTime, orgId, objectId, createdBy, updatedAt, ref } = record;
  return { _id, _creationTime, orgId, objectId, createdBy, updatedAt, ...(ref ? { ref } : {}), values, title: await visibleTitle(ctx, principal, record) };
}
export async function projectEvent(ctx: Ctx, principal: Principal, event: Doc<'events'>) {
  const object = await ctx.db.get(event.objectId), record = await ctx.db.get(event.recordId);
  if (!object || !canReadObject(principal, object) || (record ? !canReadRecord(principal, object, record) : !scopes(principal, object).some(s => s.records === 'all' || s.records.includes(event.recordId)))) return null;
  const fields = await ctx.db.query('fields').withIndex('by_object', q => q.eq('orgId', principal.org._id).eq('objectId', object._id)).collect();
  const visible = new Set(fields.filter(f => canReadField(principal, object, f, event.recordId)).map(f => String(f._id)));
  const mask = (values: Record<string, unknown> | null) => values && Object.fromEntries(Object.entries(values).filter(([id]) => visible.has(id)));
  const restricted = fields.some(f => !visible.has(f._id));
  return { ...event, before: mask(event.before), after: mask(event.after), reason: restricted ? undefined : event.reason };
}

export function canPropose(principal: Principal, object: Doc<'objects'>, recordId?: Id<'records'>, fieldIds: string[] = []) {
  if ('member' in principal) return true;
  const a = principal.agent, legacy = a.authorityVersion === 1 ? a.readObjectIds?.includes(object._id) : principal.org.authorityFrozenAt !== undefined && object._creationTime <= principal.org.authorityFrozenAt;
  return legacy || (principal.capabilities ?? []).some(g => g.capability === 'propose' && g.scope.kind === 'records' && g.scope.objectId === object._id && (g.scope.records === 'all' || (recordId !== undefined && g.scope.records.includes(recordId))) && fieldIds.every(id => g.scope.kind === 'records' && g.scope.fields.includes(id as Id<'fields'>)));
}
