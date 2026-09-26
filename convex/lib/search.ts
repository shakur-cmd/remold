import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { Principal } from "../identity";
import { canQueryField, canReadRecord, listedRecordIds, listedRecords, visibleTitle } from "../authority/reads";

const words = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);
// Like the search index: every term matches a whole word, the last one a prefix.
const score = (title: string, terms: string[]) => { const have = words(title); return terms.filter((term, i) => have.some(word => i === terms.length - 1 ? word.startsWith(term) : word === term)).length; };

// True when the caller can read every record of the object and its search title,
// so the search index holds no match they cannot see.
async function fullySearchable(ctx: QueryCtx, principal: Principal, object: Doc<"objects">, depth = 0): Promise<boolean> {
  if (depth > 5 || listedRecordIds(principal, object) !== null || !object.titleFieldId) return false;
  const field = await ctx.db.get(object.titleFieldId);
  if (!field || !canQueryField(principal, object, field)) return false;
  if (field.type !== "lookup") return true;
  const target = field.targetObjectId ? await ctx.db.get(field.targetObjectId) : null;
  return !!target && fullySearchable(ctx, principal, target, depth + 1);
}

// Title search and recent-first lists for pickers, the search box and agents. No
// answer depends on rows the caller cannot read: a record-scoped caller is matched
// against their own list, a caller who sees every row uses the index, and an object
// whose titles the caller cannot fully see is left out.
export async function searchRecords(ctx: QueryCtx, principal: Principal, text: string, objectId: Id<"objects"> | undefined, limit: number): Promise<Doc<"records">[]> {
  const orgId = principal.org._id;
  if (limit <= 0) return [];
  const objects = objectId ? [await ctx.db.get(objectId)].filter((o): o is Doc<"objects"> => !!o && o.orgId === orgId) : await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
  // Defence in depth: the index paths only meet readable rows, so this drops nothing.
  const byId = new Map(objects.map(o => [o._id, o]));
  const readableOnly = (rows: Doc<"records">[]) => rows.filter(r => { const o = byId.get(r.objectId); return !!o && canReadRecord(principal, o, r); });
  if (!text) {
    if (!objectId || !objects.length) return [];
    const listed = await listedRecords(ctx, principal, objects[0]!);
    return listed ? listed.sort((a, b) => b.updatedAt - a.updatedAt || b._creationTime - a._creationTime).slice(0, limit) : readableOnly(await ctx.db.query("records").withIndex("by_object_updated", (q) => q.eq("orgId", orgId).eq("objectId", objectId)).order("desc").take(limit));
  }
  const searchable = await Promise.all(objects.map(object => fullySearchable(ctx, principal, object)));
  if (!objectId && searchable.every(Boolean)) return readableOnly(await ctx.db.query("records").withSearchIndex("search_title", (q) => q.search("title", text).eq("orgId", orgId)).take(limit));
  const terms = words(text);
  const perObject = await Promise.all(objects.map(async (object, i) => {
    if (searchable[i]) return readableOnly(await ctx.db.query("records").withSearchIndex("search_title", (q) => q.search("title", text).eq("orgId", orgId).eq("objectId", object._id)).take(limit));
    const listed = await listedRecords(ctx, principal, object);
    if (!listed) return [];
    const scored = await Promise.all(listed.map(async record => ({ record, score: score(await visibleTitle(ctx, principal, record), terms) })));
    return scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt).slice(0, limit).map(x => x.record);
  }));
  // Take from each object in turn, so no object's results depend on another's.
  const out: Doc<"records">[] = [];
  for (let i = 0; out.length < limit && perObject.some(list => i < list.length); i++) for (const list of perObject) if (i < list.length && out.length < limit) out.push(list[i]!);
  return out;
}
