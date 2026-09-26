import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { requireMember } from "./identity";
import { canReadObject, canReadField, projectRecord } from "./authority/reads";
import { dueTasks, quietDeals } from "./lib/daily";

const DAY = 24 * 60 * 60 * 1000;
const QUIET_DAYS = 14;

async function standard(ctx: QueryCtx, orgId: Id<"orgs">, key: string) {
  const object = await ctx.db.query("objects").withIndex("by_org_key", (q) => q.eq("orgId", orgId).eq("key", key)).unique();
  if (!object) return null;
  const fields = await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", object._id)).collect();
  return { object, byKey: new Map(fields.map((field) => [field.key, field])) };
}

// The daily list: open tasks due within the next week (overdue first), and
// open opportunities nobody has touched in two weeks. `today` is the caller's
// local date as UTC midnight, the same encoding date fields use.
export const get = query({ args: { orgId: v.id("orgs"), today: v.number() }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId);
  const task = await standard(ctx, args.orgId, "task");
  const due = task?.byKey.get("dueDate"), done = task?.byKey.get("done");
  const tasks = task && !due?.retired ? await dueTasks(ctx, principal, task.object, due, done, args.today + 8 * DAY, 50) : [];
  const deal = await standard(ctx, args.orgId, "opportunity");
  const quiet = deal ? await quietDeals(ctx, principal, deal.object, deal.byKey.get("stage"), Date.now() - QUIET_DAYS * DAY, 20) : [];
  return {
    task: task && due && canReadObject(principal, task.object) && canReadField(principal, task.object, due) ? { objectKey: task.object.key, dueFieldId: due._id, doneFieldId: done?._id ?? null } : null,
    tasks: (await Promise.all(tasks.slice(0, 50).map(r => projectRecord(ctx, principal, r)))).filter((r): r is Doc<"records"> => r !== null),
    dealKey: deal && canReadObject(principal, deal.object) ? deal.object.key : null,
    quiet: (await Promise.all(quiet.map(r => projectRecord(ctx, principal, r)))).filter((r): r is Doc<"records"> => r !== null),
  };
} });
