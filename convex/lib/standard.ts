import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { allocateSlot, kindFor } from "./slots";

type FieldDef = { key: string; label: string; type: "text" | "number" | "select" | "date" | "boolean" | "lookup" | "links"; required?: boolean; indexed?: false; target?: string; withTime?: true; options?: { id: string; label: string }[] };
type ObjectDef = { key: string; label: string; plural: string; fields: FieldDef[] };
// Only fields people sort or filter by get an indexed slot; an object has 8
// text slots and notes or address lines would use them up.
const standard: ObjectDef[] = [
  { key: "company", label: "Company", plural: "Companies", fields: [{ key: "name", label: "Name", type: "text", required: true }, { key: "domain", label: "Domain", type: "text" }, { key: "city", label: "City", type: "text" }, { key: "notes", label: "Notes", type: "text", indexed: false }, { key: "street", label: "Street", type: "text", indexed: false }, { key: "state", label: "State", type: "text", indexed: false }, { key: "postalCode", label: "Postal Code", type: "text", indexed: false }, { key: "country", label: "Country", type: "text", indexed: false }] },
  { key: "person", label: "Person", plural: "People", fields: [{ key: "name", label: "Name", type: "text", required: true }, { key: "email", label: "Email", type: "text" }, { key: "phone", label: "Phone", type: "text" }, { key: "title", label: "Title", type: "text" }, { key: "company", label: "Company", type: "lookup", target: "company" }, { key: "linkedin", label: "LinkedIn", type: "text", indexed: false }] },
  { key: "opportunity", label: "Opportunity", plural: "Opportunities", fields: [{ key: "name", label: "Name", type: "text", required: true }, { key: "amount", label: "Amount", type: "number" }, { key: "stage", label: "Stage", type: "select", options: ["new", "contacted", "qualified", "proposal", "won", "lost"].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })) }, { key: "closeDate", label: "Close Date", type: "date" }, { key: "company", label: "Company", type: "lookup", target: "company" }, { key: "person", label: "Person", type: "lookup", target: "person" }] },
  { key: "project", label: "Project", plural: "Projects", fields: [{ key: "name", label: "Name", type: "text", required: true }, { key: "status", label: "Status", type: "select", options: ["active", "paused", "done"].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })) }, { key: "company", label: "Company", type: "lookup", target: "company" }] },
  { key: "task", label: "Task", plural: "Tasks", fields: [{ key: "title", label: "Title", type: "text", required: true }, { key: "dueDate", label: "Due Date", type: "date", withTime: true }, { key: "done", label: "Done", type: "boolean" }, { key: "project", label: "Project", type: "lookup", target: "project" }, { key: "blockedBy", label: "Blocked By", type: "links", target: "task" }, { key: "about", label: "About", type: "lookup" }] },
  { key: "note", label: "Note", plural: "Notes", fields: [{ key: "body", label: "Body", type: "text", required: true }, { key: "about", label: "About", type: "lookup" }] },
  { key: "activity", label: "Activity", plural: "Activities", fields: [{ key: "title", label: "Title", type: "text", required: true }, { key: "type", label: "Type", type: "select", options: ["call", "email", "meeting", "payment", "message", "other"].map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) })) }, { key: "when", label: "When", type: "date", withTime: true }, { key: "about", label: "About", type: "lookup" }, { key: "source", label: "Source", type: "text" }] },
  { key: "campaign", label: "Campaign", plural: "Campaigns", fields: [{ key: "name", label: "Name", type: "text", required: true }, { key: "status", label: "Status", type: "select", options: ["planned", "active", "paused", "done"].map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) })) }, { key: "channel", label: "Channel", type: "select", options: [{ id: "email", label: "Email" }, { id: "phone", label: "Phone" }, { id: "inPerson", label: "In person" }, { id: "social", label: "Social" }] }, { key: "startDate", label: "Start Date", type: "date" }, { key: "goal", label: "Goal", type: "text" }, { key: "people", label: "People", type: "links", target: "person" }, { key: "companies", label: "Companies", type: "links", target: "company" }] },
  { key: "post", label: "Post", plural: "Posts", fields: [{ key: "title", label: "Title", type: "text", required: true }, { key: "channel", label: "Channel", type: "select", options: [{ id: "tiktok", label: "TikTok" }, { id: "instagram", label: "Instagram" }, { id: "facebook", label: "Facebook" }, { id: "x", label: "X" }, { id: "linkedin", label: "LinkedIn" }, { id: "youtube", label: "YouTube" }, { id: "other", label: "Other" }] }, { key: "planned", label: "Planned", type: "date", withTime: true }, { key: "status", label: "Status", type: "select", options: ["idea", "drafted", "approved", "published", "skipped"].map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) })) }, { key: "text", label: "Text", type: "text", indexed: false }, { key: "mediaLink", label: "Media Link", type: "text", indexed: false }, { key: "publishedLink", label: "Published Link", type: "text", indexed: false }, { key: "campaign", label: "Campaign", type: "lookup", target: "campaign" }] },
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
    const present = new Map((await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", objectId)).collect()).map((field) => [field.key, field]));
    for (const [order, field] of definition.fields.entries()) {
      const existing = present.get(field.key);
      // Older orgs gain time of day on standard dates; an explicit false is left alone.
      if (existing) { if (field.withTime && existing.type === "date" && existing.withTime === undefined) await ctx.db.patch(existing._id, { withTime: true }); continue; }
      const kind = field.indexed === false ? undefined : kindFor(field.type);
      const fieldId = await ctx.db.insert("fields", { orgId, objectId, key: field.key, label: field.label, type: field.type, options: field.options, targetObjectId: field.target ? ids[field.target] : undefined, required: field.required ?? false, ...(field.withTime ? { withTime: true } : {}), slot: kind ? await allocateSlot(ctx, orgId, objectId, kind) : undefined, encoding: 1, retired: false, order });
      if (order === 0) await ctx.db.patch(objectId, { titleFieldId: fieldId });
    }
  }
}

export { standard };
