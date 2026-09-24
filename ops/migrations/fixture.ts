import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { seedStandard } from "./lib/standard";

// Copied only into the disposable local migration deployment.
export const seed = internalMutation({
  args: { keyHash: v.string() },
  handler: async (ctx, { keyHash }) => {
    const userId = await ctx.db.insert("users", { tokenIdentifier: "migration-fixture", name: "Synthetic migration user" });
    const orgId = await ctx.db.insert("orgs", { name: "Synthetic migration org", createdBy: userId });
    await ctx.db.insert("members", { orgId, userId, role: "owner" });
    await seedStandard(ctx, orgId);
    const object = await ctx.db.query("objects").withIndex("by_org_key", q => q.eq("orgId", orgId).eq("key", "company")).unique();
    if (!object?.titleFieldId) throw new Error("Company fixture missing");
    const agentId = await ctx.db.insert("agents", { orgId, name: "Retained synthetic key", role: "member", createdBy: userId, keyHash, keyPrefix: "synthetic", grants: [{ action: "create", objectKey: "company" }, { action: "update", objectKey: "company" }] });
    return { orgId, userId, objectId: object._id, titleFieldId: object.titleFieldId, agentId };
  },
});
export const seedBatch = internalMutation({
  args: { orgId: v.id("orgs"), userId: v.id("users"), objectId: v.id("objects"), titleFieldId: v.id("fields"), start: v.number(), count: v.number() },
  handler: async (ctx, args) => {
    if (args.count > 100 || args.start < 0) throw new Error("Bounded fixture batches only");
    for (let i = args.start; i < args.start + args.count; i++) {
      const title = `Migration fixture ${i.toString().padStart(4, "0")}`;
      await ctx.db.insert("records", { orgId: args.orgId, objectId: args.objectId, values: { [args.titleFieldId]: title }, title, createdBy: args.userId, updatedAt: 0 });
    }
  },
});
export const allowResume = internalMutation({
  args: { orgId: v.id("orgs") }, handler: async (ctx, { orgId }) => {
    await ctx.db.patch(orgId, { flags: { migrationResume: true } });
  },
});
export const snapshot = internalQuery({ args: {}, handler: async (ctx) => ({
  records: (await ctx.db.query("records").collect()).map(record => ({ ...record })),
  agents: (await ctx.db.query("agents").collect()).map(({ _id, orgId, revokedAt, keyHash }) => ({ _id, orgId, revokedAt: revokedAt ?? null, keyHash })),
  events: (await ctx.db.query("events").collect()).length,
}) });
