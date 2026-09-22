import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { allocateSlot, kindFor } from "./slots";

type FieldDef = { key: string; label: string; type: "text" | "number" | "select" | "date" | "boolean" | "lookup" | "links"; required?: boolean; target?: string; options?: { id: string; label: string }[] };
type ObjectDef = { key: string; label: string; plural: string; fields: FieldDef[] };
const standard: ObjectDef[] = [
  { key: "company", label: "Company", plural: "Companies", fields: [{ key: "name", label: "Name", type: "text", required: true }, { key: "domain", label: "Domain", type: "text" }, { key: "city", label: "City", type: "text" }, { key: "notes", label: "Notes", type: "text" }] },
  { key: "person", label: "Person", plural: "People", fields: [{ key: "name", label: "Name", type: "text", required: true }, { key: "email", label: "Email", type: "text" }, { key: "phone", label: "Phone", type: "text" }, { key: "title", label: "Title", type: "text" }, { key: "company", label: "Company", type: "lookup", target: "company" }] },
  { key: "opportunity", label: "Opportunity", plural: "Opportunities", fields: [{ key: "name", label: "Name", type: "text", required: true }, { key: "amount", label: "Amount", type: "number" }, { key: "stage", label: "Stage", type: "select", options: ["new", "contacted", "qualified", "proposal", "won", "lost"].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })) }, { key: "closeDate", label: "Close Date", type: "date" }, { key: "company", label: "Company", type: "lookup", target: "company" }, { key: "person", label: "Person", type: "lookup", target: "person" }] },
  { key: "project", label: "Project", plural: "Projects", fields: [{ key: "name", label: "Name", type: "text", required: true }, { key: "status", label: "Status", type: "select", options: ["active", "paused", "done"].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })) }, { key: "company", label: "Company", type: "lookup", target: "company" }] },
  { key: "task", label: "Task", plural: "Tasks", fields: [{ key: "title", label: "Title", type: "text", required: true }, { key: "dueDate", label: "Due Date", type: "date" }, { key: "done", label: "Done", type: "boolean" }, { key: "project", label: "Project", type: "lookup", target: "project" }, { key: "blockedBy", label: "Blocked By", type: "links", target: "task" }, { key: "about", label: "About", type: "lookup" }] },
  { key: "note", label: "Note", plural: "Notes", fields: [{ key: "body", label: "Body", type: "text", required: true }, { key: "about", label: "About", type: "lookup" }] },
];

export async function seedStandard(ctx: MutationCtx, orgId: Id<"orgs">) {
  const ids: Record<string, Id<"objects">> = {};
  for (const [order, definition] of standard.entries()) ids[definition.key] = await ctx.db.insert("objects", { orgId, key: definition.key, label: definition.label, labelPlural: definition.plural, isStandard: true, order });
  for (const definition of standard) {
    const objectId = ids[definition.key];
    for (const [order, field] of definition.fields.entries()) {
      const kind = kindFor(field.type);
      const fieldId = await ctx.db.insert("fields", { orgId, objectId, key: field.key, label: field.label, type: field.type, options: field.options, targetObjectId: field.target ? ids[field.target] : undefined, required: field.required ?? false, slot: kind ? await allocateSlot(ctx, orgId, objectId, kind) : undefined, encoding: 1, retired: false, order });
      if (order === 0) await ctx.db.patch(objectId, { titleFieldId: fieldId });
    }
  }
}

export { standard };
