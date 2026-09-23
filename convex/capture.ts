import { mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { requireMember, type Membership } from "./identity";
import { fail } from "./errors";
import { applyChange } from "./lib/applyChange";
import { findByTitle } from "./lib/find";

async function standard(ctx: MutationCtx, orgId: Id<"orgs">, key: string) {
  const object = await ctx.db.query("objects").withIndex("by_org_key", (q) => q.eq("orgId", orgId).eq("key", key)).unique();
  if (!object) fail("NOT_FOUND", `This organisation has no ${key} object`);
  const fields = await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", object._id)).collect();
  const byKey = new Map(fields.filter((f) => !f.retired).map((f) => [f.key, f._id]));
  // Only fields this org still has are written, so an older org never fails on a missing one.
  const pick = (values: Record<string, string | undefined>) => Object.fromEntries(Object.entries(values).flatMap(([key, value]) => (value?.trim() && byKey.has(key) ? [[byKey.get(key)!, value.trim()]] : [])));
  return { object, byKey, pick };
}

async function companyFor(ctx: MutationCtx, membership: Membership, orgId: Id<"orgs">, name: string, domain?: string) {
  const company = await standard(ctx, orgId, "company");
  const existing = await findByTitle(ctx, orgId, company.object._id, name);
  if (existing) return { id: existing._id, created: false };
  const { recordId } = await applyChange(ctx, membership, { action: "create", orgId, objectId: company.object._id, values: company.pick({ name, domain }), reason: "Saved from the browser extension" });
  return { id: recordId, created: true };
}

// What the browser extension saves: a person (linked to their company, which
// is found by name or created) or a company, plus an optional note.
export const save = mutation({
  args: {
    orgId: v.id("orgs"),
    kind: v.union(v.literal("person"), v.literal("company")),
    name: v.string(),
    title: v.optional(v.string()),
    company: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    linkedin: v.optional(v.string()),
    domain: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const membership = await requireMember(ctx, args.orgId);
    if (!args.name.trim()) fail("VALIDATION", "A name is required");
    let recordId: Id<"records">, objectKey: string, companyCreated = false;
    if (args.kind === "company") {
      const found = await companyFor(ctx, membership, args.orgId, args.name, args.domain);
      recordId = found.id;
      companyCreated = found.created;
      objectKey = "company";
    } else {
      const person = await standard(ctx, args.orgId, "person");
      const values: Record<string, unknown> = person.pick({ name: args.name, title: args.title, email: args.email, phone: args.phone, linkedin: args.linkedin });
      if (args.company?.trim() && person.byKey.has("company")) {
        const found = await companyFor(ctx, membership, args.orgId, args.company.trim(), args.domain);
        values[person.byKey.get("company")!] = found.id;
        companyCreated = found.created;
      }
      recordId = (await applyChange(ctx, membership, { action: "create", orgId: args.orgId, objectId: person.object._id, values, reason: "Saved from the browser extension" })).recordId;
      objectKey = "person";
    }
    if (args.note?.trim()) {
      const note = await standard(ctx, args.orgId, "note");
      const values: Record<string, unknown> = note.pick({ body: args.note });
      if (note.byKey.has("about")) values[note.byKey.get("about")!] = recordId;
      await applyChange(ctx, membership, { action: "create", orgId: args.orgId, objectId: note.object._id, values, reason: "Saved from the browser extension" });
    }
    return { recordId, objectKey, companyCreated };
  },
});
