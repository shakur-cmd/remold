import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { fail } from "../errors";
import type { Principal } from "../identity";
import { requireObjectRead, requireQueryField, projectRecord, listedRecords, compareIndexValues, pageList, paginateIndex } from "../authority/reads";

const slotName = (kind: string, index: number) => `${kind}${index}`;
type PageOpts = { cursor: string | null; numItems: number; endCursor?: string | null };

// One page of an object's records, unmasked. A record-scoped caller is served from
// their own record list in the index's order, so hidden rows never shorten a page.
export async function pageRecords(ctx: QueryCtx, orgId: Id<"orgs">, objectId: Id<"objects">, paginationOpts: PageOpts, sort?: { fieldId: Id<"fields">; direction: "asc" | "desc" }, filter?: { fieldId: Id<"fields">; value: unknown }, principal?: Principal): Promise<{ page: Doc<"records">[]; isDone: boolean; continueCursor: string }> {
  const object = await ctx.db.get(objectId); if (!object || object.orgId !== orgId) fail("NOT_FOUND", "Object not found");
  if (principal) requireObjectRead(principal, object);
  let name: string | undefined;
  if (sort || filter) {
    const fieldId = sort?.fieldId ?? filter!.fieldId;
    if (sort && filter && sort.fieldId !== filter.fieldId) fail("UNSUPPORTED", "Sort and filter must use the same field");
    const field = await ctx.db.get(fieldId); if (!field || field.orgId !== orgId || field.objectId !== objectId) fail("NOT_FOUND", "Field not found"); if (!field.slot) fail("UNINDEXED_FIELD", "Field is not indexed");
    if (principal) requireQueryField(principal, object, field);
    name = slotName(field.slot.kind, field.slot.index);
  }
  const listed = principal ? await listedRecords(ctx, principal, object) : null;
  if (listed) {
    const at = (r: Doc<"records">) => (r as Record<string, unknown>)[name!];
    let rows = listed;
    if (!name) rows = [...rows].sort((a, b) => b.updatedAt - a.updatedAt || b._creationTime - a._creationTime);
    else {
      if (filter) rows = rows.filter(r => compareIndexValues(at(r), filter.value ?? undefined) === 0);
      rows = [...rows].sort((a, b) => compareIndexValues(at(a), at(b)) || a._creationTime - b._creationTime);
      if (sort?.direction === "desc") rows.reverse();
    }
    return pageList(rows, paginationOpts);
  }
  if (!name) return paginateIndex(ctx.db.query("records").withIndex("by_object_updated", (q) => q.eq("orgId", orgId).eq("objectId", objectId)).order("desc"), paginationOpts);
  let builder: any = (ctx.db.query("records") as any).withIndex(`by_${name}`, (q: any) => { const base = q.eq("orgId", orgId).eq("objectId", objectId); return filter ? base.eq(name, filter.value ?? undefined) : base; });
  if (sort) builder = builder.order(sort.direction);
  return paginateIndex(builder, paginationOpts);
}

export async function listRecords(ctx: QueryCtx, orgId: Id<"orgs">, objectId: Id<"objects">, paginationOpts: PageOpts, sort?: { fieldId: Id<"fields">; direction: "asc" | "desc" }, filter?: { fieldId: Id<"fields">; value: unknown }, principal?: Principal) {
  const page: any = await pageRecords(ctx, orgId, objectId, paginationOpts, sort, filter, principal);
  return principal ? { ...page, page: (await Promise.all(page.page.map((record: Doc<"records">) => projectRecord(ctx, principal, record)))).filter(Boolean) } : page;
}

// Records of `source` that point at `targetId` through a lookup or links field, from a
// record-scoped reader's own list, in the same order as the index path. Null means
// the reader covers every source record, so the index path holds nothing hidden.
export async function listedRelated(ctx: QueryCtx, principal: Principal, source: Doc<"objects">, field: Doc<"fields">, targetId: Id<"records">): Promise<Doc<"records">[] | null> {
  const listed = await listedRecords(ctx, principal, source);
  if (!listed) return null;
  if (field.type === "links") {
    const hits = await Promise.all(listed.map(async record => ({ record, link: (await ctx.db.query("links").withIndex("by_from", (q) => q.eq("orgId", source.orgId).eq("fieldId", field._id).eq("fromRecordId", record._id)).collect()).find(link => link.toRecordId === targetId) })));
    return hits.filter(hit => hit.link).sort((a, b) => a.link!._creationTime - b.link!._creationTime).map(hit => hit.record);
  }
  const name = slotName(field.slot!.kind, field.slot!.index);
  return listed.filter(record => (record as Record<string, unknown>)[name] === targetId).sort((a, b) => a._creationTime - b._creationTime);
}
