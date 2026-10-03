import type { Doc } from "../_generated/dataModel";

export type Conflict = { fieldId: string; expected: unknown; actual: unknown };
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// What changed since a person reviewed a change (F3): an update conflicts on any field it
// writes, a delete on any difference at all. A reference cleared by cascade cleanup counts
// too: nothing proves who cleared it, so a person re-proposes. Suggestions and batch items both use this.
export function staleFields(action: "create" | "update" | "delete", record: Doc<"records">, before: Record<string, unknown>, written: string[]): Conflict[] {
  if (action === "create") return [];
  const keys = action === "delete" ? [...new Set([...Object.keys(before), ...Object.keys(record.values)])] : written;
  return keys.flatMap((id) => same(record.values[id], before[id]) ? [] : [{ fieldId: id, expected: before[id] ?? null, actual: record.values[id] ?? null }]);
}
