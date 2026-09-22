import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireMember } from "./identity";
import { applyChange } from "./lib/applyChange";
import { fail } from "./errors";

async function objectAndFields(ctx: any, orgId: any, key: string) {
  const object = await ctx.db.query("objects").withIndex("by_org_key", (q: any) => q.eq("orgId", orgId).eq("key", key)).unique();
  if (!object) fail("NOT_FOUND", "Standard object not found");
  const fields = await ctx.db.query("fields").withIndex("by_object", (q: any) => q.eq("orgId", orgId).eq("objectId", object._id)).collect();
  return { object, byKey: Object.fromEntries(fields.map((field: any) => [field.key, field._id])) };
}
export const demo = mutation({ args: { orgId: v.id("orgs") }, handler: async (ctx, args) => {
  const member = await requireMember(ctx, args.orgId, "admin");
  const company = await objectAndFields(ctx, args.orgId, "company");
  const existing = await ctx.db.query("records").withIndex("by_s0", (q) => q.eq("orgId", args.orgId).eq("objectId", company.object._id).eq("s0", "Fictional Plumbing Co")).unique();
  if (existing) return;
  const create = async (key: string, values: Record<string, unknown>) => { const item = await objectAndFields(ctx, args.orgId, key); return (await applyChange(ctx, member, { action: "create", orgId: args.orgId, objectId: item.object._id, values: Object.fromEntries(Object.entries(values).map(([field, value]) => [item.byKey[field], value])) })).recordId; };
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
} });
