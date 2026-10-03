import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { Principal } from "../identity";
import { canQueryField, canReadField, canReadObject, canReadRecord, firstVisible, listedRecords, visibleTitle } from "../authority/reads";

const CAP = 200;
export type Blocker = { _id: Id<"records">; title: string };
type Item = { object: Doc<"objects">; byKey: Map<string, Doc<"fields">> };

// The caller's open tasks, split into ready (every task they are blocked by is done) and waiting
// (with the open blockers named), each in the order to work them: dated first by due date, then undated.
// `me` is the caller's own id: a user id for a person, the agent id for an agent.
export async function myQueue(ctx: QueryCtx, principal: Principal, task: Item | null, me: string): Promise<{ mine: Doc<"records">[]; waiting: { record: Doc<"records">; on: Blocker[] }[] }> {
  const none = { mine: [], waiting: [] };
  const assignee = task?.byKey.get("assignee"), done = task?.byKey.get("done"), blockedBy = task?.byKey.get("blockedBy"), due = task?.byKey.get("dueDate");
  if (!task || !assignee?.slot || assignee.retired || !done || !canReadObject(principal, task.object)) return none;
  const gates = [assignee, done, ...(blockedBy ? [blockedBy] : [])];
  if (!gates.every((f) => canReadField(principal, task.object, f))) return none;
  const slot = `${assignee.slot.kind}${assignee.slot.index}`, object = task.object;
  const listed = await listedRecords(ctx, principal, object);
  let rows: Doc<"records">[];
  if (listed) rows = listed.filter((r) => r.values[assignee._id] === me && gates.every((f) => canReadField(principal, object, f, r._id))).slice(0, CAP);
  else if (!gates.every((f) => canQueryField(principal, object, f))) return none;
  else rows = await firstVisible((ctx.db.query("records") as any).withIndex(`by_${slot}`, (q: any) => q.eq("orgId", object.orgId).eq("objectId", object._id).eq(slot, me)) as AsyncIterable<Doc<"records">>, CAP, (r) => canReadRecord(principal, object, r) && r.values[assignee._id] === me ? r : null);
  const dueOf = (r: Doc<"records">) => (due && canReadField(principal, object, due, r._id) && typeof r.values[due._id] === "number" ? (r.values[due._id] as number) : Infinity);
  const open = rows.filter((r) => r.values[done._id] !== true).sort((a, b) => dueOf(a) - dueOf(b) || a._creationTime - b._creationTime);
  const mine: Doc<"records">[] = [], waiting: { record: Doc<"records">; on: Blocker[] }[] = [];
  for (const record of open) {
    const on: Blocker[] = [];
    for (const id of blockedBy ? ((record.values[blockedBy._id] as string[] | null | undefined) ?? []) : []) {
      const blocker = await ctx.db.get(id as Id<"records">);
      // A deleted blocker no longer blocks. One the caller cannot read still does, but is not named.
      if (blocker && blocker.values[done._id] !== true) on.push({ _id: blocker._id, title: canReadRecord(principal, object, blocker) ? await visibleTitle(ctx, principal, blocker) : "A task you cannot see" });
    }
    if (on.length) waiting.push({ record, on }); else mine.push(record);
  }
  return { mine, waiting };
}
