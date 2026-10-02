import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { requireMember, type Principal } from "./identity";
import { canReadObject, canReadField, canReadRecord, projectRecord, visibleTitle } from "./authority/reads";
import { dueTasks, quietDeals } from "./lib/daily";

const DAY = 24 * 60 * 60 * 1000;
const QUIET_DAYS = 14;

async function standard(ctx: QueryCtx, orgId: Id<"orgs">, key: string) {
  const object = await ctx.db.query("objects").withIndex("by_org_key", (q) => q.eq("orgId", orgId).eq("key", key)).unique();
  if (!object) return null;
  const fields = await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", object._id)).collect();
  return { object, byKey: new Map(fields.map((field) => [field.key, field])) };
}

// The funnel each step belongs to: a campaign the task is about, keyed by task id, when
// the caller can read both the task's About field and the campaign.
async function funnelsOf(ctx: QueryCtx, principal: Principal, tasks: Doc<"records">[], about: Doc<"fields"> | undefined) {
  const out: Record<string, { _id: Id<"records">; title: string }> = {};
  if (!about) return out;
  for (const task of tasks) {
    const id = ctx.db.normalizeId("records", String(task.values[about._id] ?? "")), target = id ? await ctx.db.get(id) : null;
    const object = target ? await ctx.db.get(target.objectId) : null;
    if (target && object?.key === "campaign" && object.orgId === principal.org._id && canReadRecord(principal, object, target)) out[task._id] = { _id: target._id, title: await visibleTitle(ctx, principal, target) };
  }
  return out;
}

// The daily list: open tasks due before `until` (overdue first), and open
// opportunities nobody has touched in two weeks, as `principal` may see them.
export async function daily(ctx: QueryCtx, principal: Principal, until: number) {
  const task = await standard(ctx, principal.org._id, "task");
  const due = task?.byKey.get("dueDate"), done = task?.byKey.get("done");
  const tasks = task && !due?.retired ? await dueTasks(ctx, principal, task.object, due, done, until, 50) : [];
  const deal = await standard(ctx, principal.org._id, "opportunity");
  const quiet = deal ? await quietDeals(ctx, principal, deal.object, deal.byKey.get("stage"), Date.now() - QUIET_DAYS * DAY, 20) : [];
  const shown = (await Promise.all(tasks.slice(0, 50).map(r => projectRecord(ctx, principal, r)))).filter((r): r is Doc<"records"> => r !== null);
  return {
    task: task && due && canReadObject(principal, task.object) && canReadField(principal, task.object, due) ? { objectKey: task.object.key, dueFieldId: due._id, dueField: due, doneFieldId: done?._id ?? null } : null,
    tasks: shown,
    funnels: await funnelsOf(ctx, principal, shown, task?.byKey.get("about")),
    dealKey: deal && canReadObject(principal, deal.object) ? deal.object.key : null,
    quiet: (await Promise.all(quiet.map(r => projectRecord(ctx, principal, r)))).filter((r): r is Doc<"records"> => r !== null),
  };
}

// `today` is the caller's local date as UTC midnight, the same encoding date fields use.
export const get = query({ args: { orgId: v.id("orgs"), today: v.number() }, handler: async (ctx, args) => daily(ctx, await requireMember(ctx, args.orgId), args.today + 8 * DAY) });
