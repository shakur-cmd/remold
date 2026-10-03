import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { Principal } from "../identity";
import { canQueryField, canReadField, canReadObject, canReadRecord, firstVisible, listedRecords, visibleTitle } from "../authority/reads";

const CAP = 200;
// Without an assignee slot the queue is built from the most recently updated open tasks only: this many
// of them, reading at most SCAN_ROWS rows, finished tasks included.
export const SCAN_OPEN = 2000, SCAN_ROWS = 8000;
// With the slot, the person's own tasks are read newest first, finished ones skipped before anything is counted.
const INDEX_ROWS = 5000;
export type Blocker = { _id: Id<"records">; title: string };
type Item = { object: Doc<"objects">; byKey: Map<string, Doc<"fields">> };

// The caller's open tasks, split into ready (every task they are blocked by is done) and waiting
// (with the open blockers named), each in the order to work them: dated first by due date, then undated.
// `me` is the caller's own id: a user id for a person, the agent id for an agent.
export async function myQueue(ctx: QueryCtx, principal: Principal, task: Item | null, me: string): Promise<{ mine: Doc<"records">[]; waiting: { record: Doc<"records">; on: Blocker[] }[] }> {
  const none = { mine: [], waiting: [] };
  const assignee = task?.byKey.get("assignee"), done = task?.byKey.get("done"), blockedBy = task?.byKey.get("blockedBy"), due = task?.byKey.get("dueDate");
  if (!task || !assignee || assignee.retired || !done || !canReadObject(principal, task.object)) return none;
  const gates = [assignee, done, ...(blockedBy ? [blockedBy] : [])];
  if (!gates.every((f) => canReadField(principal, task.object, f))) return none;
  const object = task.object, open = (r: Doc<"records">) => r.values[done._id] !== true, mineOf = (r: Doc<"records">) => r.values[assignee._id] === me && open(r);
  const listed = await listedRecords(ctx, principal, object);
  let rows: Doc<"records">[];
  if (listed) rows = listed.filter((r) => mineOf(r) && gates.every((f) => canReadField(principal, object, f, r._id))).slice(0, CAP);
  else if (!gates.every((f) => canQueryField(principal, object, f))) return none;
  else if (assignee.slot) {
    const slot = `${assignee.slot.kind}${assignee.slot.index}`;
    rows = await firstVisible((ctx.db.query("records") as any).withIndex(`by_${slot}`, (q: any) => q.eq("orgId", object.orgId).eq("objectId", object._id).eq(slot, me)).order("desc") as AsyncIterable<Doc<"records">>, CAP, (r) => mineOf(r) && canReadRecord(principal, object, r) ? r : null, INDEX_ROWS);
  } else {
    rows = []; let opens = 0, read = 0;
    for await (const r of ctx.db.query("records").withIndex("by_object_updated", (q) => q.eq("orgId", object.orgId).eq("objectId", object._id)).order("desc")) {
      if (open(r)) { opens++; if (mineOf(r) && canReadRecord(principal, object, r)) rows.push(r); }
      if (opens >= SCAN_OPEN || ++read >= SCAN_ROWS || rows.length >= CAP) break;
    }
  }
  const dueOf = (r: Doc<"records">) => (due && canReadField(principal, object, due, r._id) && typeof r.values[due._id] === "number" ? (r.values[due._id] as number) : Infinity);
  const ordered = rows.sort((a, b) => dueOf(a) - dueOf(b) || a._creationTime - b._creationTime);
  const mine: Doc<"records">[] = [], waiting: { record: Doc<"records">; on: Blocker[] }[] = [];
  for (const record of ordered) {
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
