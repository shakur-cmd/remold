import { internalMutation, internalQuery, mutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { ownerOf, requireMember, type Membership } from "./identity";
import { applyChange, lookupReferrers } from "./lib/applyChange";
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

// What seedDemo creates, in order. Cleanup is a reviewed one-off: the dry run
// plans the rows with these titles, and the real run deletes only the ids it is
// given, refusing all of them if any one fails the same checks.
const demoRows: [string, string][] = [["company", "Fictional Plumbing Co"], ["company", "Atlas Imaginary Works"], ["company", "Example Electric LLC"], ["person", "Ava Example"], ["person", "Ben Sample"], ["person", "Casey Fiction"], ["person", "Drew Placeholder"], ["opportunity", "Fictional Plumbing Website"], ["opportunity", "Atlas Demo Proposal"], ["opportunity", "Plumbing Sample Renewal"], ["project", "Fictional Plumbing Refresh"], ["task", "Review fictional brief"], ["task", "Prepare sample draft"], ["task", "Send imaginary update"], ["note", "Fictional customer note"], ["note", "Sample project note"]];
const seedIndex = (key: string | undefined, title: string) => demoRows.findIndex(([k, t]) => k === key && t === title);

// Why a record must stay, given the set of ids planned to go with it. Deleting a
// record rewrites every record that links to it, so any referrer outside the set keeps it.
async function keepReasons(ctx: QueryCtx, orgId: Id<"orgs">, record: Doc<"records">, planned: Set<string>) {
  const reasons: string[] = [];
  if (seedIndex((await ctx.db.get(record.objectId))?.key, record.title) < 0) reasons.push("title/object not in the seed list");
  const history = await ctx.db.query("events").withIndex("by_record", (q) => q.eq("orgId", orgId).eq("recordId", record._id)).collect();
  if (history.length !== 1 || history[0]!.action !== "create") reasons.push("has events other than its create");
  const links = await ctx.db.query("links").withIndex("by_target_any", (q) => q.eq("orgId", orgId).eq("toRecordId", record._id)).collect();
  const referrers = [...links.map((row) => row.fromRecordId), ...(await lookupReferrers(ctx, orgId, record)).map(({ record }) => record._id)];
  if (referrers.some((id) => id !== record._id && !planned.has(id))) reasons.push("referenced by a record outside the plan");
  return reasons;
}

async function summary(ctx: QueryCtx, record: Doc<"records">) {
  return { id: record._id, ref: record.ref ?? null, object: (await ctx.db.get(record.objectId))?.key ?? "", title: record.title, createdAt: new Date(record._creationTime).toISOString() };
}

// Dry run (`convex run seed:demoPlan`): every record with a seed title and object,
// split into removable and kept-with-reasons. Keeping one can keep others it links
// to, so it repeats until nothing changes. Writes nothing.
export const demoPlan = internalQuery({
  args: { orgId: v.id("orgs") },
  handler: async (ctx, { orgId }) => {
    const candidates: Doc<"records">[] = [];
    for (const object of await ctx.db.query("objects").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()) {
      const titles = new Set(demoRows.filter(([key]) => key === object.key).map(([, title]) => title));
      if (titles.size) candidates.push(...(await ctx.db.query("records").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", object._id)).collect()).filter((record) => titles.has(record.title)));
    }
    const planned = new Set<string>(candidates.map((record) => record._id)), reasons = new Map<string, string[]>();
    for (let changed = true; changed;) {
      changed = false;
      for (const record of candidates.filter((record) => planned.has(record._id))) {
        const why = await keepReasons(ctx, orgId, record, planned);
        if (why.length) { planned.delete(record._id); reasons.set(record._id, why); changed = true; }
      }
    }
    const remove = [], kept = [];
    for (const record of candidates) {
      if (planned.has(record._id)) remove.push(await summary(ctx, record));
      else kept.push({ ...(await summary(ctx, record)), reasons: reasons.get(record._id)! });
    }
    return { remove, kept };
  },
});

// Deletes exactly the reviewed ids from demoPlan as the owner, named "demo cleanup"
// in history (`convex run seed:removeDemo`). Nothing outside the list is updated or deleted.
export const removeDemo = internalMutation({
  args: { orgId: v.id("orgs"), ids: v.array(v.string()) },
  handler: async (ctx, { orgId, ids }) => {
    const planned = new Set(ids), records: Doc<"records">[] = [], problems: string[] = [];
    for (const id of planned) {
      const recordId = ctx.db.normalizeId("records", id), record = recordId && await ctx.db.get(recordId);
      if (!record || record.orgId !== orgId) { problems.push(`${id}: not found in this workspace`); continue; }
      const why = await keepReasons(ctx, orgId, record, planned);
      if (why.length) problems.push(`${record.title} (${(await ctx.db.get(record.objectId))?.key}): ${why.join("; ")}`);
      records.push(record);
    }
    if (problems.length) fail("VALIDATION", `Demo cleanup refused, nothing deleted:\n${problems.join("\n")}`);
    const owner = await ownerOf(ctx, orgId);
    const actor = { kind: "automation" as const, id: `demo cleanup ${new Date().toISOString().slice(0, 10)}` };
    const removed = await Promise.all(records.map((record) => summary(ctx, record)));
    // Dependents first, so listed rows about to go get no reference-clearing updates.
    const order = removed.map((row, index) => ({ index, at: seedIndex(row.object, row.title) })).sort((a, b) => b.at - a.at);
    for (const { index } of order) await applyChange(ctx, owner, { action: "delete", orgId, recordId: records[index]!._id, reason: "Demo cleanup" }, { actor });
    return { removed };
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
