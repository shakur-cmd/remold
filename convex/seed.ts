import { internalMutation, mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { requireMember, type Membership } from "./identity";
import { applyChange } from "./lib/applyChange";
import { seedStandard } from "./lib/standard";
import { fail } from "./errors";

async function objectAndFields(ctx: MutationCtx, orgId: Id<"orgs">, key: string) {
  const object = await ctx.db.query("objects").withIndex("by_org_key", (q) => q.eq("orgId", orgId).eq("key", key)).unique();
  if (!object) fail("NOT_FOUND", "Standard object not found");
  const fields = await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", object._id)).collect();
  return { object, byKey: Object.fromEntries(fields.map((field) => [field.key, field._id])) };
}

async function seedDemo(ctx: MutationCtx, member: Membership, orgId: Id<"orgs">) {
  const company = await objectAndFields(ctx, orgId, "company");
  const existing = await ctx.db.query("records").withIndex("by_s0", (q) => q.eq("orgId", orgId).eq("objectId", company.object._id).eq("s0", "Fictional Plumbing Co")).unique();
  if (existing) return;
  const create = async (key: string, values: Record<string, unknown>) => {
    const item = await objectAndFields(ctx, orgId, key);
    const mapped = Object.fromEntries(Object.entries(values).map(([field, value]) => [item.byKey[field]!, value]));
    return (await applyChange(ctx, member, { action: "create", orgId, objectId: item.object._id, values: mapped })).recordId;
  };
  const fictional = await create("company", { name: "Fictional Plumbing Co", city: "Fabletown" });
  const atlas = await create("company", { name: "Atlas Imaginary Works", city: "Sample City" });
  await create("company", { name: "Example Electric LLC", city: "Demo Bay" });
  const ava = await create("person", { name: "Ava Example", company: fictional });
  const ben = await create("person", { name: "Ben Sample", company: fictional });
  await create("person", { name: "Casey Fiction", company: atlas });
  await create("person", { name: "Drew Placeholder", company: atlas });
  await create("opportunity", { name: "Fictional Plumbing Website", stage: "new", company: fictional, person: ava });
  await create("opportunity", { name: "Atlas Demo Proposal", stage: "proposal", company: atlas });
  await create("opportunity", { name: "Plumbing Sample Renewal", stage: "won", company: fictional, person: ben });
  const project = await create("project", { name: "Fictional Plumbing Refresh", status: "active", company: fictional });
  const first = await create("task", { title: "Review fictional brief", project });
  await create("task", { title: "Prepare sample draft", project, blockedBy: [first] });
  await create("task", { title: "Send imaginary update", project });
  await create("note", { body: "Fictional customer note", about: fictional });
  await create("note", { body: "Sample project note", about: project });
}

export const demo = mutation({
  args: { orgId: v.id("orgs") },
  handler: async (ctx, args) => seedDemo(ctx, await requireMember(ctx, args.orgId, "admin"), args.orgId),
});

// CLI seeding (`convex run seed:demoAs`) has no signed-in identity, so the
// member is named explicitly and must be an admin of the org.
export const demoAs = internalMutation({
  args: { orgId: v.id("orgs"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    const member = await ctx.db.query("members").withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", args.userId)).unique();
    const org = await ctx.db.get(args.orgId);
    if (!user || !member || !org || member.role === "member") fail("FORBIDDEN", "Admin membership required");
    await seedDemo(ctx, { user, actor: { kind: "user", id: user._id }, member, org }, args.orgId);
  },
});

// Adds any standard object this org predates (`convex run seed:ensureStandard`).
export const ensureStandard = internalMutation({
  args: { orgId: v.id("orgs") },
  handler: (ctx, args) => seedStandard(ctx, args.orgId),
});
