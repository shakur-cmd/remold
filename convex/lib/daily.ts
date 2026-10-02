import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { Principal } from "../identity";
import { canReadObject, canReadField, canReadRecord, canQueryField, firstVisible, listedRecords } from "../authority/reads";

const slotOf = (field: Doc<"fields">) => `${field.slot!.kind}${field.slot!.index}`;

// Open tasks due before `until`, earliest first. A record-scoped caller is served
// from their list, keeping only records whose due and done fields they can read
// before looking at those values. Anyone else must be able to read both fields on
// every record, so the only rows skipped are tasks the caller can see are done.
export async function dueTasks(ctx: QueryCtx, principal: Principal, task: Doc<"objects">, due: Doc<"fields"> | undefined, done: Doc<"fields"> | undefined, until: number, limit: number): Promise<Doc<"records">[]> {
  if (!canReadObject(principal, task) || !due?.slot || !canReadField(principal, task, due) || (done && !canReadField(principal, task, done))) return [];
  const open = (row: Doc<"records">) => !done || row.values[done._id] !== true;
  const at = (row: Doc<"records">) => (row as Record<string, unknown>)[slotOf(due)];
  const listed = await listedRecords(ctx, principal, task);
  if (listed) return listed.filter(row => canReadField(principal, task, due, row._id) && (!done || canReadField(principal, task, done, row._id))).filter(row => typeof at(row) === "number" && (at(row) as number) > 0 && (at(row) as number) < until && open(row)).sort((a, b) => (at(a) as number) - (at(b) as number) || a._creationTime - b._creationTime).slice(0, limit);
  if (!canQueryField(principal, task, due) || (done && !canQueryField(principal, task, done))) return [];
  const rows = (ctx.db.query("records") as any).withIndex(`by_${slotOf(due)}`, (q: any) => q.eq("orgId", task.orgId).eq("objectId", task._id).gt(slotOf(due), 0).lt(slotOf(due), until));
  return firstVisible<Doc<"records">, Doc<"records">>(rows, limit, row => open(row) && canReadRecord(principal, task, row) ? row : null);
}

// Opportunities untouched since `before` that are not won or lost, longest untouched first.
export async function quietDeals(ctx: QueryCtx, principal: Principal, deal: Doc<"objects">, stage: Doc<"fields"> | undefined, before: number, limit: number): Promise<Doc<"records">[]> {
  if (!canReadObject(principal, deal) || (stage && !canReadField(principal, deal, stage))) return [];
  const open = (row: Doc<"records">) => { const value = stage ? row.values[stage._id] : undefined; return value !== "won" && value !== "lost"; };
  const listed = await listedRecords(ctx, principal, deal);
  if (listed) return listed.filter(row => !stage || canReadField(principal, deal, stage, row._id)).filter(row => row.updatedAt < before && open(row)).sort((a, b) => a.updatedAt - b.updatedAt || a._creationTime - b._creationTime).slice(0, limit);
  if (stage && !canQueryField(principal, deal, stage)) return [];
  return firstVisible(ctx.db.query("records").withIndex("by_object_updated", (q) => q.eq("orgId", deal.orgId).eq("objectId", deal._id).lt("updatedAt", before)), limit, row => open(row) && canReadRecord(principal, deal, row) ? row : null);
}
