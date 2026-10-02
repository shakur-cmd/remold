import { internalMutation, internalQuery, mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { ownerOf, requireMember, type Membership } from "./identity";
import { applyChange } from "./lib/applyChange";
import { seedStandard, standard } from "./lib/standard";
import { releaseSlot } from "./lib/slots";
import { uniqueRef } from "./lib/ref";
import { fail } from "./errors";
import { writable } from "./authority/readonly";

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

// What seedDemo creates, in order. Its rows are written in one transaction, so
// their create events are consecutive in the workspace history.
const demoRows: [string, string][] = [["company", "Fictional Plumbing Co"], ["company", "Atlas Imaginary Works"], ["company", "Example Electric LLC"], ["person", "Ava Example"], ["person", "Ben Sample"], ["person", "Casey Fiction"], ["person", "Drew Placeholder"], ["opportunity", "Fictional Plumbing Website"], ["opportunity", "Atlas Demo Proposal"], ["opportunity", "Plumbing Sample Renewal"], ["project", "Fictional Plumbing Refresh"], ["task", "Review fictional brief"], ["task", "Prepare sample draft"], ["task", "Send imaginary update"], ["note", "Fictional customer note"], ["note", "Sample project note"]];
type Row = { id: Id<"records">; object: string; title: string };

// Finds the seed's run of create events, then sorts its surviving rows into
// untouched (remove) and edited since (kept). A row a person made later with a
// demo title is outside the run and never listed.
async function demoPlanFor(ctx: QueryCtx, orgId: Id<"orgs">) {
  const remove: Row[] = [], kept: (Row & { reason: string })[] = [];
  const objects = new Map((await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()).map((object) => [object._id, object]));
  const company = [...objects.values()].find((object) => object.key === "company");
  const titleOf = (event: { objectId: Id<"objects">; after: Record<string, unknown> | null }) => { const object = objects.get(event.objectId); return object?.titleFieldId ? event.after?.[object.titleFieldId] : undefined; };
  const creates = company ? await ctx.db.query("events").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", company._id)).filter((q) => q.eq(q.field("action"), "create")).collect() : [];
  const anchor = creates.find((event) => titleOf(event) === demoRows[0]![1]);
  if (!anchor) return { remove, kept };
  const run = await ctx.db.query("events").withIndex("by_org", (q) => q.eq("orgId", orgId).gte("_creationTime", anchor._creationTime)).take(demoRows.length);
  for (const [index, event] of run.entries()) {
    const [key, title] = demoRows[index]!;
    if (event.action !== "create" || objects.get(event.objectId)?.key !== key || titleOf(event) !== title) break;
    const record = await ctx.db.get(event.recordId);
    if (!record) continue;
    const history = await ctx.db.query("events").withIndex("by_record", (q) => q.eq("orgId", orgId).eq("recordId", record._id)).collect();
    const row = { id: record._id, object: key, title: record.title };
    if (history.some((other) => other._id !== event._id && other.reason !== "Linked record was deleted")) kept.push({ ...row, reason: "edited after seeding" });
    else remove.push(row);
  }
  return { remove, kept };
}

// Dry run for removeDemo (`convex run seed:demoPlan`).
export const demoPlan = internalQuery({ args: { orgId: v.id("orgs") }, handler: (ctx, args) => demoPlanFor(ctx, args.orgId) });

// Deletes the untouched demo rows as the owner, named "demo cleanup" in history (`convex run seed:removeDemo`).
export const removeDemo = internalMutation({
  args: { orgId: v.id("orgs") },
  handler: async (ctx, args) => {
    const { remove, kept } = await demoPlanFor(ctx, args.orgId);
    const owner = await ownerOf(ctx, args.orgId);
    const actor = { kind: "automation" as const, id: `demo cleanup ${new Date().toISOString().slice(0, 10)}` };
    // Dependents first, so rows about to go get no reference-clearing updates.
    for (const row of [...remove].reverse()) await applyChange(ctx, owner, { action: "delete", orgId: args.orgId, recordId: row.id, reason: "Demo cleanup" }, { actor });
    return { removed: remove, kept };
  },
});

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
  // Operator maintenance still respects a workspace hold.
  handler: async (ctx, args) => { await writable(ctx, args.orgId); return seedStandard(ctx, args.orgId); },
});

// Gives a code to records created before codes existed (`convex run seed:backfillRefs`).
export const backfillRefs = internalMutation({
  args: { orgId: v.id("orgs") },
  handler: async (ctx, args) => {
    await writable(ctx, args.orgId);
    const objects = await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect();
    let count = 0;
    for (const object of objects) {
      const records = await ctx.db.query("records").withIndex("by_object", (q) => q.eq("orgId", args.orgId).eq("objectId", object._id)).collect();
      for (const record of records) if (!record.ref) { await ctx.db.patch(record._id, { ref: await uniqueRef(ctx, args.orgId) }); count += 1; }
    }
    return count;
  },
});

// Frees slots held by standard fields that are no longer indexed (notes and
// address lines), for orgs seeded before that changed (`convex run seed:releaseStandardSlots`).
export const releaseStandardSlots = internalMutation({
  args: { orgId: v.id("orgs") },
  handler: async (ctx, args) => {
    await writable(ctx, args.orgId);
    const released: string[] = [];
    for (const definition of standard) {
      const object = await ctx.db.query("objects").withIndex("by_org_key", (q) => q.eq("orgId", args.orgId).eq("key", definition.key)).unique();
      if (!object) continue;
      for (const def of definition.fields.filter((field) => field.indexed === false)) {
        const field = await ctx.db.query("fields").withIndex("by_object_key", (q) => q.eq("orgId", args.orgId).eq("objectId", object._id).eq("key", def.key)).unique();
        if (field?.slot) { await releaseSlot(ctx, field); released.push(`${definition.key}.${def.key}`); }
      }
    }
    return released;
  },
});
