import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export type Conflict = { fieldId: string; expected: unknown; actual: unknown };
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// A lookup or links value that differs only by records since deleted was cleared by
// reference cleanup (often an earlier item of the same batch), not edited by someone.
async function cleared(ctx: MutationCtx, field: Doc<"fields"> | undefined, before: unknown, now: unknown) {
  if (field?.type === "lookup") return (now === undefined || now === null) && typeof before === "string" && !await ctx.db.get(before as Id<"records">);
  if (field?.type !== "links" || !Array.isArray(before)) return false;
  const kept = []; for (const id of before as Id<"records">[]) if (await ctx.db.get(id)) kept.push(id);
  return same(kept.length ? kept : undefined, Array.isArray(now) && !now.length ? undefined : now);
}

// What changed since a person reviewed a change (F3): an update conflicts on any field it
// writes, a delete on any field of the record. Suggestions and batch items both use this.
export async function staleFields(ctx: MutationCtx, action: "create" | "update" | "delete", record: Doc<"records">, before: Record<string, unknown>, written: string[]): Promise<Conflict[]> {
  if (action === "create") return [];
  const keys = action === "delete" ? [...new Set([...Object.keys(before), ...Object.keys(record.values)])] : written;
  const fields = action === "delete" ? await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", record.orgId).eq("objectId", record.objectId)).collect() : [];
  const out: Conflict[] = [];
  for (const id of keys) if (!same(record.values[id], before[id]) && !(action === "delete" && await cleared(ctx, fields.find((f) => f._id === id), before[id], record.values[id]))) out.push({ fieldId: id, expected: before[id] ?? null, actual: record.values[id] ?? null });
  return out;
}
