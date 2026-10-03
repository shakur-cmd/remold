import { afterEach, describe, expect, it, vi } from "vitest";
import { anyApi } from "convex/server";
import { agentFor, api, objectFields, rest, userAndOrg } from "./test.helpers";
import { RemoldClient } from "../packages/mcp/src/client";

// Job G: retire, restore, reorder, archive and retitle, for a person in Settings and for
// an admin agent through a shape proposal that a person applies.
const fields = anyApi.fields, objects = anyApi.objects, shape = anyApi.shapeSuggestions;
type World = Awaited<ReturnType<typeof world>>;
async function world() {
  const f = await userAndOrg();
  // Created before the agent, so the agent can read it.
  const venueId = await f.client.mutation(api.objects.create, { orgId: f.orgId, key: "venue", label: "Venue", labelPlural: "Venues" });
  const venue = await objectFields(f.client, f.orgId, "venue");
  await f.client.mutation(api.fields.create, { orgId: f.orgId, objectId: venueId, key: "capacity", label: "Capacity", type: "number" });
  await f.client.mutation(api.fields.create, { orgId: f.orgId, objectId: venueId, key: "city", label: "City", type: "text" });
  await f.client.mutation(api.fields.create, { orgId: f.orgId, objectId: venueId, key: "kind", label: "Kind", type: "select", options: [{ id: "hall", label: "Hall" }, { id: "bar", label: "Bar" }, { id: "park", label: "Park" }] });
  const opportunity = await objectFields(f.client, f.orgId, "opportunity");
  await f.client.mutation(api.fields.create, { orgId: f.orgId, objectId: opportunity.object._id, key: "venue", label: "Venue", type: "lookup", targetObjectId: venueId });
  const agent = await agentFor(f.client, f.orgId, { name: "shaper", role: "admin" });
  return { ...f, agent, call: rest(f.t, agent.key), venueId, nameId: venue.fields.name._id };
}
const v = async (w: World, key: string) => objectFields(w.client, w.orgId, key);
const propose = (w: World, body: Record<string, unknown>) => w.call("POST", "/api/v1/shape/proposals", { reason: "tidy up", ...body });
const pending = (w: World) => w.client.query(shape.list, { orgId: w.orgId, status: "pending" });
async function proposeAndApply(w: World, body: Record<string, unknown>) {
  const made = await propose(w, body);
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const applied = await w.client.mutation(shape.apply, { orgId: w.orgId, id: made.json.proposal.id });
  expect(applied.status, JSON.stringify(applied)).toBe("applied");
  return made.json.proposal;
}
const restObject = async (w: World, key: string, query = "") => ((await w.call("GET", `/api/v1/objects${query}`)).json as any[]).find((o) => o.key === key);
const message = (promise: Promise<unknown>) => promise.then(() => null, (error: any) => error.data?.message ?? String(error));
async function venueRecords(w: World) {
  const venue = await v(w, "venue"), ids = [];
  for (const [name, city] of [["Old Hall", "Leeds"], ["The Yard", "York"], ["Park Stage", undefined]] as const) ids.push((await w.client.mutation(api.records.create, { orgId: w.orgId, objectId: w.venueId, values: { [venue.fields.name._id]: name, ...(city ? { [venue.fields.city._id]: city } : {}) } })).recordId);
  return ids;
}
const audits = (w: World): Promise<{ action: string; before?: string }[]> => w.t.run(async (ctx: any) => (await ctx.db.query("authorityAudit").collect()).filter((a: any) => a.action !== "legacyGrantsFrozen").map((a: any) => ({ action: a.action, before: a.before })));
afterEach(() => { vi.useRealTimers(); });

// The person's mutation and the agent's proposal must refuse alike, with nothing stored.
async function parity(w: World, human: () => Promise<unknown>, body: Record<string, unknown>) {
  const personError = await message(human()), agent = await propose(w, body);
  expect(agent.status).toBeGreaterThanOrEqual(400);
  expect(await pending(w)).toEqual([]);
  return { personError, agentError: agent.json.error.message };
}

describe("same rules and messages for a person and an agent", () => {
  it("retireField: title, protected standard fields, already retired", async () => {
    const w = await world(), person = await v(w, "person"), task = await v(w, "task"), venue = await v(w, "venue");
    expect(await parity(w, () => w.client.mutation(fields.retire, { orgId: w.orgId, fieldId: venue.fields.name._id }), { kind: "retireField", object: "venue", field: "name" })).toEqual({ personError: "Cannot retire title field", agentError: "Cannot retire title field" });
    expect(await parity(w, () => w.client.mutation(fields.retire, { orgId: w.orgId, fieldId: person.fields.email._id }), { kind: "retireField", object: "person", field: "email" })).toEqual({ personError: "Email cannot be retired: campaign sending needs it", agentError: "Email cannot be retired: campaign sending needs it" });
    expect(await parity(w, () => w.client.mutation(fields.retire, { orgId: w.orgId, fieldId: task.fields.dueDate._id }), { kind: "retireField", object: "task", field: "dueDate" })).toEqual({ personError: "Due Date cannot be retired: Today needs it", agentError: "Due Date cannot be retired: Today needs it" });
    const post = await v(w, "post");
    expect(await parity(w, () => w.client.mutation(fields.retire, { orgId: w.orgId, fieldId: post.fields.publishedLink._id }), { kind: "retireField", object: "post", field: "publishedLink" })).toEqual({ personError: "Published Link cannot be retired: a post is published only with its published link", agentError: "Published Link cannot be retired: a post is published only with its published link" });
    await w.client.mutation(fields.retire, { orgId: w.orgId, fieldId: venue.fields.city._id });
    expect(await parity(w, () => w.client.mutation(fields.retire, { orgId: w.orgId, fieldId: venue.fields.city._id }), { kind: "retireField", object: "venue", field: "city" })).toEqual({ personError: "Field is already retired", agentError: "Field is already retired" });
  });
  it("restoreField: a field that is not retired", async () => {
    const w = await world(), venue = await v(w, "venue");
    expect(await parity(w, () => w.client.mutation(fields.restore, { orgId: w.orgId, fieldId: venue.fields.city._id }), { kind: "restoreField", object: "venue", field: "city" })).toEqual({ personError: "Field is not retired", agentError: "Field is not retired" });
  });
  it("reorderFields: a list that leaves out or repeats a field", async () => {
    const w = await world(), venue = await v(w, "venue"), f = venue.fields;
    expect(await parity(w, () => w.client.mutation(fields.reorder, { orgId: w.orgId, objectId: w.venueId, fieldIds: [f.city._id, f.name._id, f.kind._id] }), { kind: "reorderFields", object: "venue", order: ["city", "name", "kind"] })).toEqual({ personError: "List every field of the object once", agentError: "List every field of the object once" });
    expect(await parity(w, () => w.client.mutation(fields.reorder, { orgId: w.orgId, objectId: w.venueId, fieldIds: [f.city._id, f.city._id, f.name._id, f.kind._id] }), { kind: "reorderFields", object: "venue", order: ["city", "city", "name", "kind"] })).toEqual({ personError: "List every field of the object once", agentError: "List every field of the object once" });
  });
  it("reorderObjects: a list that leaves out an object", async () => {
    const w = await world(), list = (await w.client.query(api.objects.list, { orgId: w.orgId })).slice(1);
    expect(await parity(w, () => w.client.mutation(objects.reorder, { orgId: w.orgId, objectIds: list.map((o: any) => o._id) }), { kind: "reorderObjects", order: list.map((o: any) => o.key) })).toEqual({ personError: "List every object once", agentError: "List every object once" });
  });
  it("reorderOptions: a missing option, and a field without options", async () => {
    const w = await world(), venue = await v(w, "venue");
    expect(await parity(w, () => w.client.mutation(fields.reorderOptions, { orgId: w.orgId, fieldId: venue.fields.kind._id, optionIds: ["park", "hall"] }), { kind: "reorderOptions", object: "venue", field: "kind", order: ["park", "hall"] })).toEqual({ personError: "List every option once", agentError: "List every option once" });
    expect(await parity(w, () => w.client.mutation(fields.reorderOptions, { orgId: w.orgId, fieldId: venue.fields.city._id, optionIds: [] }), { kind: "reorderOptions", object: "venue", field: "city", order: [] })).toEqual({ personError: "Only select fields have options", agentError: "Only select fields have options" });
  });
  it("archiveObject and unarchiveObject: standard objects, and an object not archived", async () => {
    const w = await world(), company = await v(w, "company");
    expect(await parity(w, () => w.client.mutation(objects.setArchived, { orgId: w.orgId, objectId: company.object._id, archived: true }), { kind: "archiveObject", object: "company" })).toEqual({ personError: "Standard objects cannot be archived", agentError: "Standard objects cannot be archived" });
    expect(await parity(w, () => w.client.mutation(objects.setArchived, { orgId: w.orgId, objectId: w.venueId, archived: false }), { kind: "unarchiveObject", object: "venue" })).toEqual({ personError: "Object is not archived", agentError: "Object is not archived" });
  });
  it("setTitleField: only a text field, and not the current one", async () => {
    const w = await world(), venue = await v(w, "venue");
    expect(await parity(w, () => w.client.mutation(objects.setTitleField, { orgId: w.orgId, objectId: w.venueId, fieldId: venue.fields.capacity._id }), { kind: "setTitleField", object: "venue", field: "capacity" })).toEqual({ personError: "Only a text field can be the title", agentError: "Only a text field can be the title" });
    expect(await parity(w, () => w.client.mutation(objects.setTitleField, { orgId: w.orgId, objectId: w.venueId, fieldId: venue.fields.name._id }), { kind: "setTitleField", object: "venue", field: "name" })).toEqual({ personError: "This is already the title field", agentError: "This is already the title field" });
  });
  it("addField unindexed: only a text field can skip the index", async () => {
    const w = await world();
    expect(await parity(w, () => w.client.mutation(api.fields.create, { orgId: w.orgId, objectId: w.venueId, key: "rooms", label: "Rooms", type: "number", indexed: false } as any), { kind: "addField", object: "venue", key: "rooms", label: "Rooms", type: "number", indexed: false })).toEqual({ personError: "Only text fields can skip the index", agentError: "Only text fields can skip the index" });
  });
});

describe("who may change the shape", () => {
  it("a member-role person is refused every lifecycle change", async () => {
    const w = await world(), venue = await v(w, "venue");
    const { token } = await w.client.mutation(api.invites.create, { orgId: w.orgId, role: "member" });
    const member = w.t.withIdentity({ tokenIdentifier: "clerk|M", name: "M" }); await member.mutation(api.users.store, {}); await member.mutation(api.invites.accept, { token });
    const list = await w.client.query(api.objects.list, { orgId: w.orgId }), f = venue.fields;
    const calls = [
      member.mutation(fields.retire, { orgId: w.orgId, fieldId: f.city._id }),
      member.mutation(fields.restore, { orgId: w.orgId, fieldId: f.city._id }),
      member.mutation(fields.reorder, { orgId: w.orgId, objectId: w.venueId, fieldIds: [f.city._id, f.name._id, f.capacity._id, f.kind._id] }),
      member.mutation(fields.reorderOptions, { orgId: w.orgId, fieldId: f.kind._id, optionIds: ["park", "bar", "hall"] }),
      member.mutation(objects.reorder, { orgId: w.orgId, objectIds: list.map((o: any) => o._id).reverse() }),
      member.mutation(objects.setArchived, { orgId: w.orgId, objectId: w.venueId, archived: true }),
      member.mutation(objects.setTitleField, { orgId: w.orgId, objectId: w.venueId, fieldId: f.city._id }),
      member.query(objects.impact, { orgId: w.orgId, objectId: w.venueId }),
    ];
    for (const call of calls) await expect(call).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    expect((await v(w, "venue")).object.archived).toBeUndefined();
  });
  it("a read-only workspace refuses every lifecycle change", async () => {
    const w = await world(), f = (await v(w, "venue")).fields, list = await w.client.query(api.objects.list, { orgId: w.orgId });
    const made = await propose(w, { kind: "archiveObject", object: "venue" });
    await w.t.run((ctx: any) => ctx.db.patch(w.orgId, { flags: { readonly: true } }));
    for (const call of [
      w.client.mutation(fields.retire, { orgId: w.orgId, fieldId: f.city._id }),
      w.client.mutation(fields.restore, { orgId: w.orgId, fieldId: f.city._id }),
      w.client.mutation(fields.reorder, { orgId: w.orgId, objectId: w.venueId, fieldIds: [f.city._id, f.name._id, f.capacity._id, f.kind._id] }),
      w.client.mutation(fields.reorderOptions, { orgId: w.orgId, fieldId: f.kind._id, optionIds: ["park", "bar", "hall"] }),
      w.client.mutation(objects.reorder, { orgId: w.orgId, objectIds: list.map((o: any) => o._id).reverse() }),
      w.client.mutation(objects.setArchived, { orgId: w.orgId, objectId: w.venueId, archived: true }),
      w.client.mutation(objects.setTitleField, { orgId: w.orgId, objectId: w.venueId, fieldId: f.city._id }),
      w.client.mutation(shape.apply, { orgId: w.orgId, id: made.json.proposal.id }),
    ]) await expect(call).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    expect((await propose(w, { kind: "retireField", object: "venue", field: "city" })).status).toBe(403);
    expect((await v(w, "venue")).object.archived).toBeUndefined();
  });
  it("a member-role agent cannot propose any lifecycle kind", async () => {
    const w = await world(), helper = rest(w.t, (await agentFor(w.client, w.orgId, { name: "helper" })).key);
    for (const body of [{ kind: "retireField", object: "venue", field: "city" }, { kind: "restoreField", object: "venue", field: "city" }, { kind: "reorderFields", object: "venue", order: ["city", "name", "capacity", "kind"] }, { kind: "reorderObjects", order: ["venue"] }, { kind: "reorderOptions", object: "venue", field: "kind", order: ["park", "bar", "hall"] }, { kind: "archiveObject", object: "venue" }, { kind: "unarchiveObject", object: "venue" }, { kind: "setTitleField", object: "venue", field: "city" }]) {
      const refused = await helper("POST", "/api/v1/shape/proposals", { reason: "x", ...body });
      expect(refused.status).toBe(403);
      expect(refused.json.error.code).toBe("FORBIDDEN");
    }
    expect(await pending(w)).toEqual([]);
  });
});

describe("retire and restore", () => {
  it("a person retires and restores a field; values were kept and come back", async () => {
    const w = await world(), [hall] = await venueRecords(w), venue = await v(w, "venue");
    await w.client.mutation(fields.retire, { orgId: w.orgId, fieldId: venue.fields.city._id });
    expect((await restObject(w, "venue")).fields.map((f: any) => f.key)).not.toContain("city");
    expect((await restObject(w, "venue")).retiredFields).toEqual([{ key: "city", label: "City", type: "text" }]);
    expect((await w.call("GET", `/api/v1/records/${hall}`)).json.record.values.city).toBeUndefined();
    await w.client.mutation(fields.restore, { orgId: w.orgId, fieldId: venue.fields.city._id });
    expect((await w.call("GET", `/api/v1/records/${hall}`)).json.record.values.city).toBe("Leeds");
    expect((await v(w, "venue")).fields.city.slot).toEqual(venue.fields.city.slot);
    expect((await audits(w)).map((a) => a.action)).toEqual(["retireField", "restoreField"]);
  });
  it("an agent proposes retiring, the person sees the impact, applies, and an agent proposal restores it", async () => {
    const w = await world();
    await venueRecords(w);
    const proposal = await propose(w, { kind: "retireField", object: "venue", field: "city" });
    expect(proposal.status).toBe(201);
    expect(proposal.json.proposal.summary).toBe("Retire field City on Venue");
    const [row] = await pending(w);
    expect(await w.client.query(objects.impact, { orgId: w.orgId, ...row.preview })).toEqual(["2 records of 3 hold a value. Values are kept and come back if you restore it.", "People, agents, imports and exports stop seeing it."]);
    expect((await v(w, "venue")).fields.city).toBeDefined();
    await w.client.mutation(shape.apply, { orgId: w.orgId, id: row._id });
    expect((await v(w, "venue")).fields.city).toBeUndefined();
    await proposeAndApply(w, { kind: "restoreField", object: "venue", field: "city" });
    expect((await v(w, "venue")).fields.city).toBeDefined();
    expect((await audits(w)).map((a) => a.action)).toEqual(["retireField", "shapeProposalApplied", "restoreField", "shapeProposalApplied"]);
  });
  it("impact counting stops at the first 500 records and says so", async () => {
    const w = await world(), venue = await v(w, "venue");
    await w.t.run(async (ctx: any) => { const member = (await ctx.db.query("members").collect())[0]; for (let i = 0; i < 501; i++) await ctx.db.insert("records", { orgId: w.orgId, objectId: w.venueId, values: { [venue.fields.name._id]: `V${i}`, ...(i % 2 ? {} : { [venue.fields.city._id]: "Leeds" }) }, title: `V${i}`, createdBy: member.userId, updatedAt: i }); });
    expect((await w.client.query(objects.impact, { orgId: w.orgId, objectId: w.venueId, fieldId: venue.fields.city._id }))[0]).toBe("250 of the first 500 records hold a value. Values are kept and come back if you restore it.");
    expect((await w.client.query(objects.impact, { orgId: w.orgId, objectId: w.venueId }))[0]).toBe("More than 500 records kept. Links to them keep working.");
  });
  it("a relation field's retire impact names the links that stop showing", async () => {
    const w = await world(), opportunity = await v(w, "opportunity");
    expect(await w.client.query(objects.impact, { orgId: w.orgId, objectId: opportunity.object._id, fieldId: opportunity.fields.venue._id })).toEqual(["0 records of 0 hold a value. Values are kept and come back if you restore it.", "Its links stop showing on Venues until it is restored.", "People, agents, imports and exports stop seeing it."]);
  });
  it("restore is refused when another field now holds its slot, and an unindexed restore keeps values", async () => {
    const w = await world(), [hall] = await venueRecords(w), venue = await v(w, "venue");
    await w.client.mutation(fields.retire, { orgId: w.orgId, fieldId: venue.fields.city._id });
    // Only a migration that releases slots (releaseSlot) can hand a retired field's slot to another field.
    const made = await w.client.mutation(api.fields.create, { orgId: w.orgId, objectId: w.venueId, key: "region", label: "Region", type: "text" });
    await w.t.run((ctx: any) => ctx.db.patch(made.fieldId, { slot: venue.fields.city.slot }));
    expect(await parity(w, () => w.client.mutation(fields.restore, { orgId: w.orgId, fieldId: venue.fields.city._id }), { kind: "restoreField", object: "venue", field: "city" })).toEqual({ personError: "City cannot be restored: its index slot is now used by Region", agentError: "City cannot be restored: its index slot is now used by Region" });
    // A proposal made before the slot moved fails at apply, with nothing changed.
    await w.t.run((ctx: any) => ctx.db.patch(made.fieldId, { slot: undefined }));
    const early = await propose(w, { kind: "restoreField", object: "venue", field: "city" });
    await w.t.run((ctx: any) => ctx.db.patch(made.fieldId, { slot: venue.fields.city.slot }));
    expect(await w.client.mutation(shape.apply, { orgId: w.orgId, id: early.json.proposal.id })).toEqual({ status: "failed", error: "City cannot be restored: its index slot is now used by Region" });
    expect((await w.t.run((ctx: any) => ctx.db.get(venue.fields.city._id)) as any).retired).toBe(true);
    // With its slot released instead, the field comes back unindexed and its values are intact.
    await w.t.run((ctx: any) => ctx.db.patch(venue.fields.city._id, { slot: undefined }));
    await w.client.mutation(fields.restore, { orgId: w.orgId, fieldId: venue.fields.city._id });
    expect((await restObject(w, "venue")).fields.find((f: any) => f.key === "city")).toMatchObject({ indexed: false });
    expect((await w.call("GET", `/api/v1/records/${hall}`)).json.record.values.city).toBe("Leeds");
  });
});

describe("reorder", () => {
  it("a person and an agent reorder fields; REST lists the new order", async () => {
    const w = await world(), f = (await v(w, "venue")).fields;
    const keys = async () => (await restObject(w, "venue")).fields.map((x: any) => x.key);
    expect(await keys()).toEqual(["name", "capacity", "city", "kind"]);
    await w.client.mutation(fields.reorder, { orgId: w.orgId, objectId: w.venueId, fieldIds: [f.city._id, f.name._id, f.kind._id, f.capacity._id] });
    expect(await keys()).toEqual(["city", "name", "kind", "capacity"]);
    await proposeAndApply(w, { kind: "reorderFields", object: "venue", order: ["kind", "capacity", "name", "city"] });
    expect(await keys()).toEqual(["kind", "capacity", "name", "city"]);
    expect((await audits(w)).filter((a) => a.action === "reorderFields").map((a) => a.before)).toEqual(["name,capacity,city,kind", "city,name,kind,capacity"]);
  });
  it("retired fields stay out of the list and keep their place after it", async () => {
    const w = await world(), f = (await v(w, "venue")).fields;
    await w.client.mutation(fields.retire, { orgId: w.orgId, fieldId: f.capacity._id });
    await w.client.mutation(fields.reorder, { orgId: w.orgId, objectId: w.venueId, fieldIds: [f.kind._id, f.city._id, f.name._id] });
    await w.client.mutation(fields.restore, { orgId: w.orgId, fieldId: f.capacity._id });
    expect((await restObject(w, "venue")).fields.map((x: any) => x.key)).toEqual(["kind", "city", "name", "capacity"]);
  });
  it("a person and an agent reorder objects; REST lists the new order", async () => {
    const w = await world(), list = await w.client.query(api.objects.list, { orgId: w.orgId });
    const keys = async () => ((await w.call("GET", "/api/v1/objects")).json as any[]).map((o) => o.key);
    const reversed = list.map((o: any) => o._id).reverse();
    await w.client.mutation(objects.reorder, { orgId: w.orgId, objectIds: reversed });
    expect(await keys()).toEqual(list.map((o: any) => o.key).reverse());
    const moved = ["venue", ...list.map((o: any) => o.key).filter((k: string) => k !== "venue")];
    const proposal = await proposeAndApply(w, { kind: "reorderObjects", order: moved });
    expect(proposal.summary).toBe("Reorder the objects in the navigation");
    expect(await keys()).toEqual(moved);
    expect((await w.client.query(api.objects.list, { orgId: w.orgId })).map((o: any) => o.key)).toEqual(moved);
  });
  it("a person and an agent reorder select options; REST shows them in order", async () => {
    const w = await world(), f = (await v(w, "venue")).fields;
    const order = async () => (await restObject(w, "venue")).fields.find((x: any) => x.key === "kind").options.map((o: any) => o.id);
    await w.client.mutation(fields.reorderOptions, { orgId: w.orgId, fieldId: f.kind._id, optionIds: ["park", "hall", "bar"] });
    expect(await order()).toEqual(["park", "hall", "bar"]);
    const proposal = await proposeAndApply(w, { kind: "reorderOptions", object: "venue", field: "kind", order: ["bar", "park", "hall"] });
    expect(proposal.details).toEqual(["New order: Bar, Park, Hall"]);
    expect(await order()).toEqual(["bar", "park", "hall"]);
  });
});

describe("archive and unarchive", () => {
  it("archived objects leave agents' lists and search, records and links stay, unarchive brings them back", async () => {
    const w = await world(), [hall] = await venueRecords(w), opportunity = await v(w, "opportunity");
    const deal = await w.client.mutation(api.records.create, { orgId: w.orgId, objectId: opportunity.object._id, values: { [opportunity.fields.name._id]: "Gala", [opportunity.fields.venue._id]: hall } });
    const made = await propose(w, { kind: "archiveObject", object: "venue" });
    expect(made.json.proposal.summary).toBe("Archive object Venue");
    const [row] = await pending(w);
    expect(await w.client.query(objects.impact, { orgId: w.orgId, ...row.preview })).toEqual(["3 records kept. Links to them keep working.", "Linked from Opportunity: Venue.", "Hidden from navigation, search and the agents' object list until you unarchive it."]);
    await w.client.mutation(shape.apply, { orgId: w.orgId, id: row._id });
    expect(await restObject(w, "venue")).toBeUndefined();
    expect(await restObject(w, "venue", "?include=archived")).toMatchObject({ key: "venue", archived: true });
    const mcp = new RemoldClient({ url: "https://remold.test", key: w.agent.key, fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { const url = new URL(String(input)); return w.t.fetch(url.pathname + url.search, init); }) as typeof fetch });
    expect((await mcp.objects() as any[]).map((o) => o.key)).not.toContain("venue");
    expect((await mcp.objects({ includeArchived: true }) as any[]).find((o) => o.key === "venue")).toMatchObject({ archived: true });
    expect((await w.call("GET", "/api/v1/search?q=Hall")).json).toEqual([]);
    expect(await w.client.query(api.records.search, { orgId: w.orgId, text: "Hall" })).toEqual([]);
    // Records and links are untouched.
    expect((await w.call("GET", `/api/v1/records/${hall}`)).json.record.values.name).toBe("Old Hall");
    expect((await w.call("GET", `/api/v1/records/${deal.recordId}`)).json.record.values.venue).toMatchObject({ id: hall });
    expect((await w.call("GET", "/api/v1/records?object=venue")).json.records).toHaveLength(3);
    // The person brings it back.
    await w.client.mutation(objects.setArchived, { orgId: w.orgId, objectId: w.venueId, archived: false });
    expect(await restObject(w, "venue")).toMatchObject({ archived: false });
    expect((await w.call("GET", "/api/v1/search?q=Hall")).json.map((r: any) => r.title)).toEqual(["Old Hall"]);
    expect((await audits(w)).map((a) => a.action)).toEqual(["archiveObject", "shapeProposalApplied", "unarchiveObject"]);
  });
  it("an archived object keeps its place out of the object order list until it comes back", async () => {
    const w = await world();
    await w.client.mutation(objects.setArchived, { orgId: w.orgId, objectId: w.venueId, archived: true });
    const shown = (await w.client.query(api.objects.list, { orgId: w.orgId })).filter((o: any) => !o.archived);
    await w.client.mutation(objects.reorder, { orgId: w.orgId, objectIds: shown.map((o: any) => o._id).reverse() });
    await proposeAndApply(w, { kind: "unarchiveObject", object: "venue" });
    const keys = ((await w.call("GET", "/api/v1/objects")).json as any[]).map((o) => o.key);
    expect(keys).toEqual([...shown.map((o: any) => o.key).reverse(), "venue"]);
  });
});

describe("title field and unindexed text", () => {
  it("a person and an agent change the title field; record titles follow", async () => {
    vi.useFakeTimers();
    const w = await world(), [hall] = await venueRecords(w), f = (await v(w, "venue")).fields;
    await w.client.mutation(objects.setTitleField, { orgId: w.orgId, objectId: w.venueId, fieldId: f.city._id });
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await restObject(w, "venue")).titleField).toBe("city");
    expect((await w.call("GET", `/api/v1/records/${hall}`)).json.record.title).toBe("Leeds");
    // The old title field can now be retired.
    await w.client.mutation(fields.retire, { orgId: w.orgId, fieldId: f.name._id });
    await w.client.mutation(fields.restore, { orgId: w.orgId, fieldId: f.name._id });
    await proposeAndApply(w, { kind: "setTitleField", object: "venue", field: "name" });
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await w.call("GET", `/api/v1/records/${hall}`)).json.record.title).toBe("Old Hall");
    expect((await audits(w)).filter((a) => a.action === "setTitleField").map((a) => a.before)).toEqual(["name", "city"]);
  });
  it("an unindexed text field takes no slot; REST reports slots left per kind", async () => {
    const w = await world(), before = (await restObject(w, "venue")).slotsLeft;
    expect(before).toEqual({ text: 5, number: 7, date: 4, boolean: 4 });
    const made = await w.client.mutation(api.fields.create, { orgId: w.orgId, objectId: w.venueId, key: "notes", label: "Notes", type: "text", indexed: false } as any);
    expect(made.slot).toBeUndefined();
    await proposeAndApply(w, { kind: "addField", object: "venue", key: "story", label: "Story", type: "text", indexed: false });
    const after = await restObject(w, "venue");
    expect(after.slotsLeft).toEqual(before);
    expect(after.fields.filter((f: any) => ["notes", "story"].includes(f.key)).map((f: any) => f.indexed)).toEqual([false, false]);
  });
});

describe("no stale or hidden data through lifecycle changes", () => {
  it("after the title field changes, a reader who cannot see the old title field never gets its values as titles", async () => {
    vi.useFakeTimers();
    const w = await world(), f = (await v(w, "venue")).fields;
    await w.t.run(async (ctx: any) => { const member = (await ctx.db.query("members").collect())[0]; for (let i = 0; i < 120; i++) await ctx.db.insert("records", { orgId: w.orgId, objectId: w.venueId, values: { [f.name._id]: `Secret ${i}`, [f.city._id]: `City ${i}` }, title: `Secret ${i}`, createdBy: member.userId, updatedAt: i }); });
    const reader = await agentFor(w.client, w.orgId, { name: "reader" });
    await w.client.mutation(anyApi["authority/policies"].setAgentMasks, { orgId: w.orgId, agentId: reader.agentId, hiddenFieldIds: [f.name._id] });
    await w.client.mutation(objects.setTitleField, { orgId: w.orgId, objectId: w.venueId, fieldId: f.city._id });
    // Later pages of stored titles are rewritten afterwards; reads must not wait for them.
    const titles = (await rest(w.t, reader.key)("GET", "/api/v1/records?object=venue&limit=100")).json.records.map((r: any) => r.title);
    expect(titles).toHaveLength(100);
    expect(titles.filter((t: string) => !t.startsWith("City "))).toEqual([]);
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await w.t.run(async (ctx: any) => (await ctx.db.query("records").collect()).filter((r: any) => r.objectId === w.venueId && r.title.startsWith("Secret")).length)).toBe(0);
  });
  it("an admin scoped to one object sees no names of objects or fields hidden from them in an impact preview", async () => {
    const w = await world();
    const memberId = await w.t.run(async (ctx: any) => (await ctx.db.query("members").collect())[0]._id);
    await w.client.mutation(anyApi["authority/policies"].setMember, { orgId: w.orgId, memberId, scopes: [{ objectId: w.venueId, records: "all", fields: "all" }], hiddenFieldIds: [] });
    expect(await w.client.query(objects.impact, { orgId: w.orgId, objectId: w.venueId })).toEqual(["0 records kept. Links to them keep working.", "Hidden from navigation, search and the agents' object list until you unarchive it."]);
  });
  it("Email's subject stays protected after the title moves to another field", async () => {
    const w = await world(), email = await v(w, "email");
    await w.client.mutation(fields.create, { orgId: w.orgId, objectId: email.object._id, key: "internalName", label: "Internal Name", type: "text" });
    await w.client.mutation(objects.setTitleField, { orgId: w.orgId, objectId: email.object._id, fieldId: (await v(w, "email")).fields.internalName._id });
    expect(await parity(w, () => w.client.mutation(fields.retire, { orgId: w.orgId, fieldId: email.fields.subject._id }), { kind: "retireField", object: "email", field: "subject" })).toEqual({ personError: "Subject cannot be retired: campaign sending needs it", agentError: "Subject cannot be retired: campaign sending needs it" });
  });
});
