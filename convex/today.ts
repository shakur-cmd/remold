import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { requireMember } from "./identity";
import { canReadObject, canReadRecord, canReadField, projectRecord, firstVisible } from "./authority/reads";

const DAY = 24 * 60 * 60 * 1000;
const QUIET_DAYS = 14;

async function standard(ctx: QueryCtx, orgId: Id<"orgs">, key: string) {
  const object = await ctx.db.query("objects").withIndex("by_org_key", (q) => q.eq("orgId", orgId).eq("key", key)).unique();
  if (!object) return null;
  const fields = await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", object._id)).collect();
  return { object, byKey: new Map(fields.map((field) => [field.key, field])) };
}

const slotName = (field: Doc<"fields">) => `${field.slot!.kind}${field.slot!.index}`;

// The daily list: open tasks due within the next week (overdue first), and
// open opportunities nobody has touched in two weeks. `today` is the caller's
// local date as UTC midnight, the same encoding date fields use.
export const get = query({ args: { orgId: v.id("orgs"), today: v.number() }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId);
  const tasks: Doc<"records">[] = [];
  const task = await standard(ctx, args.orgId, "task");
  const due = task?.byKey.get("dueDate"), done = task?.byKey.get("done");
  if (task && canReadObject(principal, task.object) && due?.slot && !due.retired && canReadField(principal, task.object, due) && (!done || canReadField(principal, task.object, done))) {
    const rows = (ctx.db.query("records") as any)
      .withIndex(`by_${slotName(due)}`, (q: any) => q.eq("orgId", args.orgId).eq("objectId", task.object._id).gt(slotName(due), 0).lt(slotName(due), args.today + 8 * DAY));
    tasks.push(...await firstVisible<Doc<"records">, Doc<"records">>(rows, 50, row => canReadRecord(principal, task.object, row) && canReadField(principal, task.object, due, row._id) && (!done || (canReadField(principal, task.object, done, row._id) && row.values[done._id] !== true)) ? row : null));
  }

  const quiet: Doc<"records">[] = [];
  const deal = await standard(ctx, args.orgId, "opportunity");
  const stage = deal?.byKey.get("stage");
  if (deal && canReadObject(principal, deal.object) && (!stage || canReadField(principal, deal.object, stage))) {
    const rows = ctx.db.query("records").withIndex("by_object_updated", (q) => q.eq("orgId", args.orgId).eq("objectId", deal.object._id).lt("updatedAt", Date.now() - QUIET_DAYS * DAY));
    quiet.push(...await firstVisible(rows, 20, row => {
      if (!canReadRecord(principal, deal.object, row) || (stage && !canReadField(principal, deal.object, stage, row._id))) return null;
      const value = stage ? row.values[stage._id] : undefined;
      return value !== "won" && value !== "lost" ? row : null;
    }));
  }
  return {
    task: task && due && canReadObject(principal, task.object) && canReadField(principal, task.object, due) ? { objectKey: task.object.key, dueFieldId: due._id, doneFieldId: done?._id ?? null } : null,
    tasks: (await Promise.all(tasks.slice(0, 50).map(r => projectRecord(ctx, principal, r)))).filter((r): r is Doc<"records"> => r !== null),
    dealKey: deal && canReadObject(principal, deal.object) ? deal.object.key : null,
    quiet: (await Promise.all(quiet.map(r => projectRecord(ctx, principal, r)))).filter((r): r is Doc<"records"> => r !== null),
  };
} });
