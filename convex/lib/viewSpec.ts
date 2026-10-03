import { v, type Infer } from "convex/values";

// A saved view's stored shape. Self-contained (convex/values only) so a schema commit can carry it alone.
export const layout = v.union(v.literal("table"), v.literal("board"), v.literal("calendar"));
const relative = v.union(v.literal("today"), v.literal("next7"), v.literal("thisMonth"), v.literal("overdue"));
// Fixed dates are calendar days, read in the reader's time zone like relative ones.
export const viewRange = v.object({ fieldId: v.id("fields"), from: v.optional(v.string()), to: v.optional(v.string()), relative: v.optional(relative) });
export const viewSort = v.object({ fieldId: v.id("fields"), direction: v.union(v.literal("asc"), v.literal("desc")) });
// A filter value of null matches records where the field is empty, as in lib/list.
const filter = v.object({ fieldId: v.id("fields"), value: v.any() });
export const viewSpec = { name: v.string(), layout, columns: v.array(v.id("fields")), filters: v.array(filter), range: v.optional(viewRange), sort: v.optional(viewSort), groupFieldId: v.optional(v.id("fields")), dateFieldId: v.optional(v.id("fields")) };
const spec = v.object(viewSpec);
export type ViewSpec = Infer<typeof spec>;
