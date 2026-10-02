import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { requireMember, type Principal } from "./identity";
import { canReadObject, canReadField, projectRecord } from "./authority/reads";
import { datedRecords, dayIntervals, dueTasks, quietDeals, type LocalDays } from "./lib/daily";

const DAY = 24 * 60 * 60 * 1000;
const QUIET_DAYS = 14;

async function standard(ctx: QueryCtx, orgId: Id<"orgs">, key: string) {
  const object = await ctx.db.query("objects").withIndex("by_org_key", (q) => q.eq("orgId", orgId).eq("key", key)).unique();
  if (!object) return null;
  const fields = await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", object._id)).collect();
  return { object, byKey: new Map(fields.map((field) => [field.key, field])) };
}

// Posts planned on the viewer's local `day` that are still to go out, a page at a time.
async function todayPosts(ctx: QueryCtx, principal: Principal, day: LocalDays, cursor?: string) {
  const post = await standard(ctx, principal.org._id, "post");
  const planned = post?.byKey.get("planned"), status = post?.byKey.get("status");
  if (!post || !planned || planned.retired) return { post: null, posts: [], done: true, cursor: null };
  const page = await datedRecords(ctx, principal, post.object, planned, status ? [status] : [], r => !status || !["published", "skipped"].includes(r.values[status._id] as string), dayIntervals(day), 50, cursor);
  return {
    post: page.rows.length || !page.done ? { objectKey: post.object.key, plannedFieldId: planned._id, plannedField: planned, statusField: status ?? null } : null,
    posts: (await Promise.all(page.rows.map(r => projectRecord(ctx, principal, r)))).filter((r): r is Doc<"records"> => r !== null),
    done: page.done, cursor: page.cursor,
  };
}

// The daily list: open tasks due before `until` (overdue first), open
// opportunities nobody has touched in two weeks, and posts planned on the
// viewer's local `day` that are still to go out, as `principal` may see them.
export async function daily(ctx: QueryCtx, principal: Principal, until: number, day?: LocalDays) {
  const task = await standard(ctx, principal.org._id, "task");
  const due = task?.byKey.get("dueDate"), done = task?.byKey.get("done");
  const tasks = task && !due?.retired ? await dueTasks(ctx, principal, task.object, due, done, until, 50) : [];
  const deal = await standard(ctx, principal.org._id, "opportunity");
  const quiet = deal ? await quietDeals(ctx, principal, deal.object, deal.byKey.get("stage"), Date.now() - QUIET_DAYS * DAY, 20) : [];
  const posts = day === undefined ? null : await todayPosts(ctx, principal, day);
  return {
    task: task && due && canReadObject(principal, task.object) && canReadField(principal, task.object, due) ? { objectKey: task.object.key, dueFieldId: due._id, dueField: due, doneFieldId: done?._id ?? null } : null,
    tasks: (await Promise.all(tasks.slice(0, 50).map(r => projectRecord(ctx, principal, r)))).filter((r): r is Doc<"records"> => r !== null),
    dealKey: deal && canReadObject(principal, deal.object) ? deal.object.key : null,
    quiet: (await Promise.all(quiet.map(r => projectRecord(ctx, principal, r)))).filter((r): r is Doc<"records"> => r !== null),
    post: posts?.post ?? null,
    posts: posts?.posts ?? [],
    // Until postsDone, today.posts with postsCursor returns the rest.
    postsDone: posts?.done ?? true,
    postsCursor: posts?.cursor ?? null,
  };
}

const day = { orgId: v.id("orgs"), today: v.number(), start: v.optional(v.number()), end: v.optional(v.number()) };
// Without start and end (older clients, which may send any instant as `today`), the UTC day holding `today`.
const localDay = (args: { today: number; start?: number; end?: number }) => {
  if (args.start === undefined || args.end === undefined) { const day = Math.floor(args.today / DAY) * DAY; return { firstDay: day, lastDay: day, start: day, end: day + DAY - 1 }; }
  return { firstDay: args.today, lastDay: args.today, start: args.start, end: args.end };
};
// `today` is the caller's local date as UTC midnight, the same encoding date fields use;
// `start` and `end` bound its local day (a client without them gets the UTC day).
export const get = query({ args: day, handler: async (ctx, args) => daily(ctx, await requireMember(ctx, args.orgId), args.today + 8 * DAY, localDay(args)) });
export const posts = query({ args: { ...day, cursor: v.string() }, handler: async (ctx, args) => { const { posts, done, cursor } = await todayPosts(ctx, await requireMember(ctx, args.orgId), localDay(args), args.cursor); return { posts, done, cursor }; } });
