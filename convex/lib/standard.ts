import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { allocateSlot, kindFor } from "./slots";

type FieldDef = { key: string; label: string; type: "text" | "number" | "select" | "date" | "boolean" | "lookup" | "links"; required?: boolean; target?: string; options?: { id: string; label: string }[] };
type ObjectDef = { key: string; label: string; plural: string; fields: FieldDef[] };
const standard: ObjectDef[] = [
  { key: "company", label: "Company", plural: "Companies", fields: [{ key: "name", label: "Name", type: "text", required: true }, { key: "domain", label: "Domain", type: "text" }, { key: "city", label: "City", type: "text" }, { key: "notes", label: "Notes", type: "text" }, { key: "street", label: "Street", type: "text" }, { key: "state", label: "State", type: "text" }, { key: "postalCode", label: "Postal Code", type: "text" }, { key: "country", label: "Country", type: "text" }] },
  { key: "person", label: "Person", plural: "People", fields: [{ key: "name", label: "Name", type: "text", required: true }, { key: "email", label: "Email", type: "text" }, { key: "phone", label: "Phone", type: "text" }, { key: "title", label: "Title", type: "text" }, { key: "company", label: "Company", type: "lookup", target: "company" }] },
  { key: "opportunity", label: "Opportunity", plural: "Opportunities", fields: [{ key: "name", label: "Name", type: "text", required: true }, { key: "amount", label: "Amount", type: "number" }, { key: "stage", label: "Stage", type: "select", options: ["new", "contacted", "qualified", "proposal", "won", "lost"].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })) }, { key: "closeDate", label: "Close Date", type: "date" }, { key: "company", label: "Company", type: "lookup", target: "company" }, { key: "person", label: "Person", type: "lookup", target: "person" }] },
  { key: "project", label: "Project", plural: "Projects", fields: [{ key: "name", label: "Name", type: "text", required: true }, { key: "status", label: "Status", type: "select", options: ["active", "paused", "done"].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })) }, { key: "company", label: "Company", type: "lookup", target: "company" }] },
  { key: "task", label: "Task", plural: "Tasks", fields: [{ key: "title", label: "Title", type: "text", required: true }, { key: "dueDate", label: "Due Date", type: "date" }, { key: "done", label: "Done", type: "boolean" }, { key: "project", label: "Project", type: "lookup", target: "project" }, { key: "blockedBy", label: "Blocked By", type: "links", target: "task" }, { key: "about", label: "About", type: "lookup" }] },
  { key: "note", label: "Note", plural: "Notes", fields: [{ key: "body", label: "Body", type: "text", required: true }, { key: "about", label: "About", type: "lookup" }] },
  { key: "campaign", label: "Campaign", plural: "Campaigns", fields: [{ key: "name", label: "Name", type: "text", required: true }, { key: "status", label: "Status", type: "select", options: ["planned", "active", "paused", "done"].map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) })) }, { key: "channel", label: "Channel", type: "select", options: [{ id: "email", label: "Email" }, { id: "phone", label: "Phone" }, { id: "inPerson", label: "In person" }, { id: "social", label: "Social" }] }, { key: "startDate", label: "Start Date", type: "date" }, { key: "goal", label: "Goal", type: "text" }, { key: "people", label: "People", type: "links", target: "person" }, { key: "companies", label: "Companies", type: "links", target: "company" }] },
];

// Idempotent: objects that already exist in the org are left alone, so a
// newer standard object can be added to an older org.
export async function seedStandard(ctx: MutationCtx, orgId: Id<"orgs">) {
  const ids: Record<string, Id<"objects">> = {};
  const existing = await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
  for (const object of existing) ids[object.key] = object._id;
  const missing = standard.filter((definition) => !ids[definition.key]);
  for (const definition of missing) ids[definition.key] = await ctx.db.insert("objects", { orgId, key: definition.key, label: definition.label, labelPlural: definition.plural, isStandard: true, order: existing.length + missing.indexOf(definition) });
  for (const definition of standard) {
    const objectId = ids[definition.key]!;
    const present = new Set((await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", objectId)).collect()).map((field) => field.key));
    for (const [order, field] of definition.fields.entries()) {
      if (present.has(field.key)) continue;
      const kind = kindFor(field.type);
      const fieldId = await ctx.db.insert("fields", { orgId, objectId, key: field.key, label: field.label, type: field.type, options: field.options, targetObjectId: field.target ? ids[field.target] : undefined, required: field.required ?? false, slot: kind ? await allocateSlot(ctx, orgId, objectId, kind) : undefined, encoding: 1, retired: false, order });
      if (order === 0) await ctx.db.patch(objectId, { titleFieldId: fieldId });
    }
  }
}

export { standard };
