import { v } from "convex/values";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { fail } from "./errors";

export async function enabled(ctx: QueryCtx | MutationCtx, orgId: Id<"orgs">, flag: string): Promise<boolean> {
  const org = await ctx.db.get(orgId);
  return org?.flags?.[flag] === true;
}

export const setFlag = internalMutation({
  args: { orgId: v.id("orgs"), flag: v.string(), enabled: v.boolean(), reason: v.string() },
  handler: async (ctx, args) => {
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(args.flag)) fail("VALIDATION", "Use a short lowercase feature key");
    // Store operational references rather than free-form customer notes.
    if (!/^[a-z0-9][a-z0-9._:-]{0,99}$/.test(args.reason)) fail("VALIDATION", "Provide a short operational reason reference");
    const org = await ctx.db.get(args.orgId);
    if (!org) fail("NOT_FOUND", "Organization not found");
    const before = org.flags?.[args.flag] === true;
    if (before === args.enabled) return;
    await ctx.db.patch(args.orgId, { flags: { ...org.flags, [args.flag]: args.enabled } });
    await ctx.db.insert("opsEvents", {
      orgId: args.orgId,
      actor: { kind: "operator", id: "internal-admin" },
      action: "featureFlagChanged",
      flag: args.flag,
      before,
      after: args.enabled,
      reason: args.reason,
    });
  },
});
