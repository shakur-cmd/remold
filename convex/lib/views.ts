import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Principal } from "../identity";
import { fail } from "../errors";
import { canQueryField, canReadField, requireObjectRead, requireQueryField } from "../authority/reads";
import { pageRecords, type Where } from "./list";
import type { ViewSpec } from "./viewSpec";
export { layout, viewRange, viewSort, viewSpec, type ViewSpec } from "./viewSpec";
import { dayBounds, knownZone, relativeDays, relativeLabels, type Relative } from "./days";
import { resolveValues } from "./values";

// A saved view: what a list shows (layout, columns) and which rows (filters, range,
// sort). It only ever narrows: it runs through the same list path with the reader's
// own permissions, so a shared view never shows anyone more than they could see.
type Ctx = QueryCtx | MutationCtx;
export const MAX_VIEW_FILTERS = 3;
const MAX_COLUMNS = 20;
const isDay = (day: string | undefined) => day === undefined || (/^\d{4}-\d{2}-\d{2}$/.test(day) && new Date(`${day}T00:00:00Z`).toISOString().startsWith(day));

const fieldsOf = async (ctx: Ctx, object: Doc<"objects">) => new Map((await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", object.orgId).eq("objectId", object._id)).collect()).map((f) => [f._id as string, f]));

// Views of an archived object drop out of view lists and runs.
export const archived = (object: Doc<"objects">) => !!object.archived;

// The rules a view must meet when it is saved, by a person or by applying an agent's
// proposal. Returns the view with filter values coerced the way agent input is.
export async function checkView(ctx: Ctx, principal: Principal, object: Doc<"objects">, view: ViewSpec): Promise<ViewSpec> {
  if (!view.name.trim()) fail("VALIDATION", "Name is required");
  if (view.name.trim().length > 60) fail("VALIDATION", "Name is too long");
  const fields = await fieldsOf(ctx, object);
  const readable = (id: Id<"fields">) => { const field = fields.get(id); if (!field || field.retired || !canReadField(principal, object, field)) fail("NOT_FOUND", "Field not found"); return field; };
  // Rows are chosen or ordered by these, so they must be indexed and the same for every row the reader sees.
  const queryable = (id: Id<"fields">) => { const field = readable(id); requireQueryField(principal, object, field); if (!field.slot) fail("UNINDEXED_FIELD", "Field is not indexed"); return field; };
  if (view.columns.length > MAX_COLUMNS || new Set(view.columns).size !== view.columns.length) fail("VALIDATION", `Up to ${MAX_COLUMNS} different columns`);
  view.columns.forEach(readable);
  if (view.filters.length > MAX_VIEW_FILTERS) fail("VALIDATION", `At most ${MAX_VIEW_FILTERS} filters`);
  if (new Set(view.filters.map((f) => f.fieldId)).size !== view.filters.length) fail("VALIDATION", "One filter per field");
  const filters = [];
  for (const f of view.filters) {
    const field = queryable(f.fieldId);
    if (f.value === undefined) fail("VALIDATION", "A filter needs a value");
    filters.push({ fieldId: field._id, value: (await resolveValues(ctx, principal, object, [field], { [field.key]: f.value }))[field._id] ?? null });
  }
  if (view.range) {
    const { from, to } = view.range;
    if (queryable(view.range.fieldId).type !== "date") fail("VALIDATION", "A range needs a date field");
    if (view.range.relative) { if (from !== undefined || to !== undefined) fail("VALIDATION", "A range is relative or has dates, not both"); }
    else if (from === undefined && to === undefined) fail("VALIDATION", "A range needs a start or an end");
    else if (!isDay(from) || !isDay(to)) fail("VALIDATION", "Range dates must be YYYY-MM-DD");
    else if (from !== undefined && to !== undefined && from > to) fail("VALIDATION", "A range must start before it ends");
  }
  if (view.sort) queryable(view.sort.fieldId);
  if ((view.layout === "board" || view.groupFieldId) && (!view.groupFieldId || queryable(view.groupFieldId).type !== "select")) fail("VALIDATION", "A board view needs a select field to group by");
  if ((view.layout === "calendar" || view.dateFieldId) && (!view.dateFieldId || queryable(view.dateFieldId).type !== "date")) fail("VALIDATION", "A calendar view needs a date field");
  return { ...view, filters };
}

// The fields that choose, order or lay out a view's rows. A reader must be able to query every one.
const rowFields = (spec: ViewSpec) => [...spec.filters.map((f) => f.fieldId), ...(spec.range ? [spec.range.fieldId] : []), ...(spec.sort ? [spec.sort.fieldId] : []), ...(spec.layout === "board" ? [spec.groupFieldId!] : []), ...(spec.layout === "calendar" ? [spec.dateFieldId!] : [])];

export type Dropped = { field: string; part: "column" | "filter" | "range" | "sort" | "board" | "calendar" };
// The view as it stands now: references to retired fields are left out and listed,
// so a view keeps working after a field it used is retired. A board or calendar
// that lost its field shows as a table.
export async function effective(ctx: Ctx, view: Doc<"views">) {
  const byId = await fieldsOf(ctx, (await ctx.db.get(view.objectId))!);
  const dropped: (Dropped & { fieldId: Id<"fields"> })[] = [];
  const live = (id: Id<"fields">, part: Dropped["part"]) => { const field = byId.get(id); if (field && !field.retired) return true; dropped.push({ fieldId: id, field: field?.label ?? "A removed field", part }); return false; };
  const columns = view.columns.filter((id) => live(id, "column")), filters = view.filters.filter((f) => live(f.fieldId, "filter"));
  const range = view.range && live(view.range.fieldId, "range") ? view.range : undefined, sort = view.sort && live(view.sort.fieldId, "sort") ? view.sort : undefined;
  const groupFieldId = view.groupFieldId && live(view.groupFieldId, "board") ? view.groupFieldId : undefined, dateFieldId = view.dateFieldId && live(view.dateFieldId, "calendar") ? view.dateFieldId : undefined;
  const layout = (view.layout === "board" && !groupFieldId) || (view.layout === "calendar" && !dateFieldId) ? "table" as const : view.layout;
  const spec: ViewSpec = { name: view.name, layout, columns, filters, ...(range ? { range } : {}), ...(sort ? { sort } : {}), ...(groupFieldId ? { groupFieldId } : {}), ...(dateFieldId ? { dateFieldId } : {}) };
  return { spec, dropped, fields: byId };
}

// What a reader may see of a view. Parts naming a field they cannot read are left
// out, values included; a view that chooses or orders rows by such a field is
// blocked for them rather than run without it, which would widen it.
export async function forReader(ctx: Ctx, principal: Principal, object: Doc<"objects">, view: Doc<"views">) {
  const { spec, dropped, fields } = await effective(ctx, view);
  const field = (id: Id<"fields">) => fields.get(id)!;
  const reads = (id: Id<"fields">) => canReadField(principal, object, field(id)), queries = (id: Id<"fields">) => canQueryField(principal, object, field(id));
  const { range, sort, groupFieldId, dateFieldId } = spec;
  const shown: ViewSpec = { name: spec.name, layout: spec.layout, columns: spec.columns.filter(reads), filters: spec.filters.filter((f) => reads(f.fieldId)), ...(range && reads(range.fieldId) ? { range } : {}), ...(sort && reads(sort.fieldId) ? { sort } : {}), ...(groupFieldId && reads(groupFieldId) ? { groupFieldId } : {}), ...(dateFieldId && reads(dateFieldId) ? { dateFieldId } : {}) };
  const author = view.createdBy.kind === "agent" ? await ctx.db.get(view.createdBy.id as Id<"agents">) : await ctx.db.get(view.createdBy.id as Id<"users">);
  return { spec: shown, fields, blocked: !rowFields(spec).every(queries), dropped: dropped.filter((d) => !fields.get(d.fieldId) || reads(d.fieldId)).map(({ field, part }) => ({ field, part })), createdBy: { kind: view.createdBy.kind, name: author?.name ?? null } };
}

// One page of a view's rows for this reader. Relative ranges resolve now, in `timeZone`.
export async function runView(ctx: QueryCtx, principal: Principal, view: Doc<"views">, page: { cursor: string | null; numItems: number }, timeZone = "UTC") {
  if (!knownZone(timeZone)) fail("VALIDATION", "Unknown time zone");
  const object = await ctx.db.get(view.objectId);
  if (!object || archived(object)) fail("NOT_FOUND", "View not found");
  requireObjectRead(principal, object);
  const { spec, fields } = await effective(ctx, view);
  if (!rowFields(spec).every((id) => canQueryField(principal, object, fields.get(id)!))) fail("FORBIDDEN", "This view uses a field you cannot read");
  let range: Where["range"];
  if (spec.range) {
    const r = spec.range;
    const days = r.relative ? relativeDays(r.relative, Date.now(), timeZone) : r;
    range = { fieldId: r.fieldId, ...dayBounds(fields.get(r.fieldId)!, days.from, days.to, timeZone) };
  }
  return { object, spec, page: await pageRecords(ctx, view.orgId, view.objectId, page, spec.sort, { filters: spec.filters, range }, principal) };
}

// Plain words for Suggestions: "Board by Stage", "Stage is Proposal", "Close Date: next 7 days".
export async function viewDetails(ctx: Ctx, view: ViewSpec, pinned?: boolean) {
  const label = async (id: Id<"fields">) => (await ctx.db.get(id))?.label ?? "a removed field";
  const out: string[] = [];
  if (view.layout === "board" && view.groupFieldId) out.push(`Board by ${await label(view.groupFieldId)}`);
  if (view.layout === "calendar" && view.dateFieldId) out.push(`Calendar by ${await label(view.dateFieldId)}`);
  if (view.columns.length) out.push(`Columns: ${(await Promise.all(view.columns.map(label))).join(", ")}`);
  for (const f of view.filters) {
    const field = await ctx.db.get(f.fieldId), name = field?.label ?? "a removed field";
    const shown = f.value === null ? "empty" : field?.type === "select" ? field.options?.find((o) => o.id === f.value)?.label ?? String(f.value) : field?.type === "boolean" ? (f.value ? "yes" : "no") : field?.type === "lookup" ? "a chosen record" : String(f.value);
    out.push(`${name} is ${shown}`);
  }
  if (view.range) { const { from, to } = view.range; out.push(`${await label(view.range.fieldId)}: ${view.range.relative ? relativeLabels[view.range.relative as Relative] : from && to ? `${from} to ${to}` : from ? `from ${from}` : `until ${to}`}`); }
  if (view.sort) {
    const field = await ctx.db.get(view.sort.fieldId), asc = view.sort.direction === "asc";
    const order = field?.type === "date" ? (asc ? "earliest first" : "latest first") : field?.type === "number" ? (asc ? "low to high" : "high to low") : asc ? "A to Z" : "Z to A";
    out.push(`Sorted by ${field?.label ?? "a removed field"}, ${order}`);
  }
  if (pinned) out.push("Pinned in the menu");
  return out;
}
