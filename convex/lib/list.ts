import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { fail } from "../errors";

const slotName = (kind: string, index: number) => `${kind}${index}`;

export async function listRecords(ctx: QueryCtx, orgId: Id<"orgs">, objectId: Id<"objects">, paginationOpts: { cursor: string | null; numItems: number }, sort?: { fieldId: Id<"fields">; direction: "asc" | "desc" }, filter?: { fieldId: Id<"fields">; value: unknown }) {
  const object = await ctx.db.get(objectId); if (!object || object.orgId !== orgId) fail("NOT_FOUND", "Object not found");
  if (!sort && !filter) return ctx.db.query("records").withIndex("by_object_updated", (q) => q.eq("orgId", orgId).eq("objectId", objectId)).order("desc").paginate(paginationOpts);
  const fieldId = sort?.fieldId ?? filter!.fieldId;
  if (sort && filter && sort.fieldId !== filter.fieldId) fail("UNSUPPORTED", "Sort and filter must use the same field");
  const field = await ctx.db.get(fieldId); if (!field || field.orgId !== orgId || field.objectId !== objectId) fail("NOT_FOUND", "Field not found"); if (!field.slot) fail("UNINDEXED_FIELD", "Field is not indexed");
  const name = slotName(field.slot.kind, field.slot.index), index = `by_${name}` as any;
  let builder: any = (ctx.db.query("records") as any).withIndex(index, (q: any) => { const base = q.eq("orgId", orgId).eq("objectId", objectId); return filter ? base.eq(name, filter.value ?? undefined) : base; });
  if (sort) builder = builder.order(sort.direction);
  return builder.paginate(paginationOpts);
}
