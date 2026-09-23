import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export type SlotKind = "n" | "s" | "d" | "b";
export const kindFor = (type: Doc<"fields">["type"]): SlotKind | undefined => {
  if (type === "number") return "n";
  if (type === "text" || type === "select" || type === "lookup") return "s";
  if (type === "date") return "d";
  if (type === "boolean") return "b";
  return undefined;
};
const capacity: Record<SlotKind, number> = { n: 8, s: 8, d: 4, b: 4 };

export async function allocateSlot(ctx: MutationCtx, orgId: Id<"orgs">, objectId: Id<"objects">, kind: SlotKind) {
  const fields = await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", objectId)).collect();
  const used = new Set(fields.flatMap((field) => field.slot?.kind === kind ? [field.slot.index] : []));
  for (let index = 0; index < capacity[kind]; index += 1) if (!used.has(index)) return { kind, index } as const;
  return undefined;
}

export function projections(fields: Doc<"fields">[], values: Record<string, unknown>) {
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const field of fields) {
    if (!field.slot) continue;
    const value = values[field._id];
    out[`${field.slot.kind}${field.slot.index}`] = value == null ? undefined : value as string | number | boolean;
  }
  return out;
}

// The one exception to "a slot is never reused": clear the slot's projection on
// every record of the object, then free it, in one transaction. No record can
// then carry an old value under a slot a later field takes. Bounded by one
// object's records, so it is for migrations, not for request paths.
export async function releaseSlot(ctx: MutationCtx, field: Doc<"fields">) {
  if (!field.slot) return 0;
  const name = `${field.slot.kind}${field.slot.index}`;
  const records = await ctx.db.query("records").withIndex("by_object", (q) => q.eq("orgId", field.orgId).eq("objectId", field.objectId)).collect();
  for (const record of records) if ((record as Record<string, unknown>)[name] !== undefined) await ctx.db.patch(record._id, { [name]: undefined });
  await ctx.db.patch(field._id, { slot: undefined });
  return records.length;
}
