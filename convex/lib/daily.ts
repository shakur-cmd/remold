import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { Principal } from "../identity";
import { canReadObject, canReadField, canReadRecord, canQueryField, firstVisible, listedRecords } from "../authority/reads";

const slotOf = (field: Doc<"fields">) => `${field.slot!.kind}${field.slot!.index}`;

// Records whose `date` falls in [from, until) and that `keep` accepts, earliest
// first. A record-scoped caller is served from their list, keeping only records
// whose date and `gates` fields they can read before looking at those values.
// Anyone else must be able to read and query them on every record, so the only
// rows skipped are ones `keep` refuses on values the caller can see.
export async function datedRecords(ctx: QueryCtx, principal: Principal, object: Doc<"objects">, date: Doc<"fields"> | undefined, gates: Doc<"fields">[], keep: (row: Doc<"records">) => boolean, from: number, until: number, limit: number): Promise<Doc<"records">[]> {
  if (!canReadObject(principal, object) || !date?.slot || ![date, ...gates].every(f => canReadField(principal, object, f))) return [];
  const at = (row: Doc<"records">) => (row as Record<string, unknown>)[slotOf(date)];
  const listed = await listedRecords(ctx, principal, object);
  if (listed) return listed.filter(row => [date, ...gates].every(f => canReadField(principal, object, f, row._id))).filter(row => typeof at(row) === "number" && (at(row) as number) >= from && (at(row) as number) < until && keep(row)).sort((a, b) => (at(a) as number) - (at(b) as number) || a._creationTime - b._creationTime).slice(0, limit);
  if (![date, ...gates].every(f => canQueryField(principal, object, f))) return [];
  const rows = (ctx.db.query("records") as any).withIndex(`by_${slotOf(date)}`, (q: any) => q.eq("orgId", object.orgId).eq("objectId", object._id).gte(slotOf(date), from).lt(slotOf(date), until));
  return firstVisible<Doc<"records">, Doc<"records">>(rows, limit, row => keep(row) && canReadRecord(principal, object, row) ? row : null);
}

// Open tasks due before `until`, earliest first. Dates are integers, so from 1 is "after 0".
export const dueTasks = (ctx: QueryCtx, principal: Principal, task: Doc<"objects">, due: Doc<"fields"> | undefined, done: Doc<"fields"> | undefined, until: number, limit: number) =>
  datedRecords(ctx, principal, task, due, done ? [done] : [], row => !done || row.values[done._id] !== true, 1, until, limit);

// Opportunities untouched since `before` that are not won or lost, longest untouched first.
export async function quietDeals(ctx: QueryCtx, principal: Principal, deal: Doc<"objects">, stage: Doc<"fields"> | undefined, before: number, limit: number): Promise<Doc<"records">[]> {
  if (!canReadObject(principal, deal) || (stage && !canReadField(principal, deal, stage))) return [];
  const open = (row: Doc<"records">) => { const value = stage ? row.values[stage._id] : undefined; return value !== "won" && value !== "lost"; };
  const listed = await listedRecords(ctx, principal, deal);
  if (listed) return listed.filter(row => !stage || canReadField(principal, deal, stage, row._id)).filter(row => row.updatedAt < before && open(row)).sort((a, b) => a.updatedAt - b.updatedAt || a._creationTime - b._creationTime).slice(0, limit);
  if (stage && !canQueryField(principal, deal, stage)) return [];
  return firstVisible(ctx.db.query("records").withIndex("by_object_updated", (q) => q.eq("orgId", deal.orgId).eq("objectId", deal._id).lt("updatedAt", before)), limit, row => open(row) && canReadRecord(principal, deal, row) ? row : null);
}
