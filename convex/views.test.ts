import { afterEach, describe, expect, it, vi } from "vitest";
import { anyApi } from "convex/server";
import { agentFor, api, objectFields, rest, userAndOrg } from "./test.helpers";

const views = anyApi.views;
type F = Awaited<ReturnType<typeof userAndOrg>>;
const errorOf = (promise: Promise<unknown>) => promise.then(() => null, (error: any) => error.data?.message ?? String(error));
async function joined(f: F, name: string, role: "admin" | "member") {
  const { token } = await f.client.mutation(api.invites.create, { orgId: f.orgId, role });
  const client = f.t.withIdentity({ tokenIdentifier: `clerk|${name}`, name }); await client.mutation(api.users.store, {}); await client.mutation(api.invites.accept, { token });
  const memberId = await f.t.run(async (ctx: any) => { const user = await ctx.db.query("users").withIndex("by_token", (q: any) => q.eq("tokenIdentifier", `clerk|${name}`)).unique(); return (await ctx.db.query("members").withIndex("by_org_user", (q: any) => q.eq("orgId", f.orgId).eq("userId", user._id)).unique())._id; });
  return { client, memberId };
}
async function pipeline() {
  const f = await userAndOrg(), opp = await objectFields(f.client, f.orgId, "opportunity"), o = opp.fields;
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`);
  const rows: [string, string, number, string][] = [["Atlas", "proposal", 500, "2026-03-03"], ["Birch", "proposal", 900, "2026-03-31"], ["Cedar", "won", 700, "2026-03-10"], ["Dune", "proposal", 300, "2026-04-01"], ["Elm", "proposal", 900, "2026-03-15"], ["Fir", "proposal", 100, "2026-02-28"]];
  for (const [name, stage, amount, close] of rows) await f.client.mutation(api.records.create, { orgId: f.orgId, objectId: opp.object._id, values: { [o.name._id]: name, [o.stage._id]: stage, [o.amount._id]: amount, [o.closeDate._id]: day(close) } });
  const agent = await agentFor(f.client, f.orgId, { name: "reader", role: "admin" });
  return { ...f, opp, o, call: rest(f.t, agent.key) };
}
const allPages = async (call: ReturnType<typeof rest>, path: string) => {
  const ids: string[] = []; let cursor: string | null = null;
  do { const page: any = await call("GET", `${path}${path.includes("?") ? "&" : "?"}limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`); expect(page.status).toBe(200); ids.push(...page.json.records.map((r: any) => r.title)); cursor = page.json.cursor; } while (cursor);
  return ids;
};

afterEach(() => { vi.restoreAllMocks(); });

describe("saved views", () => {
  it("returns exactly what the same ad-hoc filters, range and sort return", async () => {
    const f = await pipeline();
    const viewId = await f.client.mutation(views.create, { orgId: f.orgId, objectId: f.opp.object._id, name: "March proposals", layout: "table", columns: [f.o.amount._id, f.o.stage._id], filters: [{ fieldId: f.o.stage._id, value: "proposal" }], range: { fieldId: f.o.closeDate._id, from: "2026-03-01", to: "2026-03-31" }, sort: { fieldId: f.o.amount._id, direction: "desc" }, shared: true });
    const saved = await allPages(f.call, `/api/v1/views/${viewId}/records`);
    const adHoc = await allPages(f.call, "/api/v1/records?object=opportunity&filter[stage]=proposal&range[closeDate]=2026-03-01..2026-03-31&sort=amount&direction=desc");
    // Birch and Elm tie on amount; the index orders ties newest first, either way.
    expect(saved).toEqual(["Elm", "Birch", "Atlas"]);
    expect(saved).toEqual(adHoc);
    // The same rows reach a person through the list the app runs for the view.
    const listed = await f.client.query(api.records.list, { orgId: f.orgId, objectId: f.opp.object._id, sort: { fieldId: f.o.amount._id, direction: "desc" }, filters: [{ fieldId: f.o.stage._id, value: "proposal" }], range: { fieldId: f.o.closeDate._id, from: Date.parse("2026-03-01T00:00:00Z"), to: Date.parse("2026-03-31T00:00:00Z") }, paginationOpts: { cursor: null, numItems: 10 } });
    expect(listed.page.map((r: any) => r.title)).toEqual(saved);
    // A view's records carry its columns, not every field.
    const first = await f.call("GET", `/api/v1/views/${viewId}/records`);
    expect(Object.keys(first.json.records[0].values).sort()).toEqual(["amount", "stage"]);
    expect(first.json.view).toMatchObject({ name: "March proposals", object: "opportunity", columns: ["amount", "stage"], filters: [{ field: "stage", value: "proposal" }], range: { field: "closeDate", from: "2026-03-01", to: "2026-03-31" }, sort: { field: "amount", direction: "desc" } });
  });

  it("resolves a relative range when it is read, in the caller's time zone, across UTC midnight and a DST change", async () => {
    const f = await userAndOrg(), task = await objectFields(f.client, f.orgId, "task"), due = task.fields.dueDate;
    const add = (title: string, value: number) => f.client.mutation(api.records.create, { orgId: f.orgId, objectId: task.object._id, values: { [task.fields.title._id]: title, [due._id]: value } });
    const at = (iso: string) => Date.parse(iso);
    await add("late Sunday", at("2026-03-09T03:30:00Z")); // 23:30 on 8 March in New York (EDT)
    await add("early Monday", at("2026-03-09T04:30:00Z")); // 00:30 on 9 March in New York
    await add("late Saturday", at("2026-03-08T04:30:00Z")); // 23:30 on 7 March in New York (EST)
    await add("all day Sunday", at("2026-03-08T00:00:00Z"));
    await add("all day Monday", at("2026-03-09T00:00:00Z"));
    await add("all day Tuesday", at("2026-03-10T00:00:00Z"));
    const viewId = await f.client.mutation(views.create, { orgId: f.orgId, objectId: task.object._id, name: "Due today", layout: "table", columns: [due._id], filters: [], range: { fieldId: due._id, relative: "today" }, sort: { fieldId: due._id, direction: "asc" }, shared: true });
    const call = rest(f.t, (await agentFor(f.client, f.orgId, { name: "reader" })).key);
    const run = async (tz?: string) => { const r = await call("GET", `/api/v1/views/${viewId}/records${tz ? `?tz=${encodeURIComponent(tz)}` : ""}`); expect(r.status).toBe(200); return r.json.records.map((x: any) => x.title).sort(); };
    const clock = vi.spyOn(Date, "now").mockReturnValue(at("2026-03-08T16:00:00Z"));
    // Clocks sprang forward on 8 March, so that day is 23 hours long in New York.
    expect(await run("America/New_York")).toEqual(["all day Sunday", "late Sunday"]);
    // 02:00Z on 10 March: still 9 March in New York, already 10 March in UTC.
    clock.mockReturnValue(at("2026-03-10T02:00:00Z"));
    expect(await run("America/New_York")).toEqual(["all day Monday", "early Monday"]);
    expect(await run()).toEqual(["all day Tuesday"]);
    expect((await call("GET", `/api/v1/views/${viewId}/records?tz=Nowhere/Land`)).status).toBe(400);
  });

  it("run by a restricted agent, hides unreadable rows and fields and refuses filters on hidden fields", async () => {
    const f = await userAndOrg(), company = await objectFields(f.client, f.orgId, "company"), c = company.fields;
    const make = async (name: string, domain: string) => (await f.client.mutation(api.records.create, { orgId: f.orgId, objectId: company.object._id, values: { [c.name._id]: name, [c.city._id]: "Boston", [c.domain._id]: domain } })).recordId;
    const mine = await make("Mine Co", "mine.example"); await make("Secret Co", "secret.example");
    const wide = await f.client.mutation(views.create, { orgId: f.orgId, objectId: company.object._id, name: "Boston", layout: "table", columns: [c.city._id, c.domain._id], filters: [{ fieldId: c.city._id, value: "Boston" }], shared: true });
    const byDomain = await f.client.mutation(views.create, { orgId: f.orgId, objectId: company.object._id, name: "By domain", layout: "table", columns: [c.city._id], filters: [{ fieldId: c.domain._id, value: "secret.example" }], shared: true });
    const agent = await f.client.action(api.agents.createScoped, { orgId: f.orgId, name: "scoped", origin: "external" });
    await f.client.mutation(api.authority.grants.grant, { orgId: f.orgId, target: agent.agentId, capability: "read", scope: { kind: "records", objectId: company.object._id, records: [mine], fields: [c.name._id, c.city._id] }, mode: "direct", delegate: false, expiresAt: Date.now() + 3600_000 });
    const call = rest(f.t, agent.key);
    const listed = await call("GET", "/api/v1/views?object=company");
    expect(listed.json.views.map((v: any) => [v.name, v.columns, v.usable])).toEqual([["Boston", ["city"], true], ["By domain", ["city"], false]]);
    expect(JSON.stringify(listed.json)).not.toMatch(/"domain"|secret\.example/);
    const ran = await call("GET", `/api/v1/views/${wide}/records`);
    expect(ran.json.records.map((r: any) => [r.title, r.values])).toEqual([["Mine Co", { city: "Boston" }]]);
    const refused = await call("GET", `/api/v1/views/${byDomain}/records`);
    expect([refused.status, refused.json.error.code]).toEqual([403, "FORBIDDEN"]);

    // A person with the same limits sees the shared views without the hidden column, and the filter view as blocked.
    const member = await joined(f, "Rae", "member");
    await f.client.mutation(anyApi["authority/policies"].setMember, { orgId: f.orgId, memberId: member.memberId, scopes: [{ objectId: company.object._id, records: [mine], fields: "all" }], hiddenFieldIds: [c.domain._id] });
    const seen = (await member.client.query(views.list, { orgId: f.orgId })).filter((v: any) => v.objectId === company.object._id);
    expect(seen.map((v: any) => [v.name, v.columns, v.filters.length, v.blocked])).toEqual([["Boston", [c.city._id], 1, false], ["By domain", [c.city._id], 0, true]]);
    const rows = await member.client.query(api.records.list, { orgId: f.orgId, objectId: company.object._id, filters: seen[0].filters, paginationOpts: { cursor: null, numItems: 10 } });
    expect(rows.page.map((r: any) => [r.title, Object.keys(r.values).includes(c.domain._id)])).toEqual([["Mine Co", false]]);
  });

  it("keeps personal views to their owner; only admins share", async () => {
    const f = await pipeline(), rae = await joined(f, "Rae", "member"), sam = await joined(f, "Sam", "member");
    const base = { orgId: f.orgId, objectId: f.opp.object._id, layout: "table", columns: [f.o.amount._id], filters: [] };
    const personal = await rae.client.mutation(views.create, { ...base, name: "Rae's deals" });
    expect((await rae.client.query(views.list, { orgId: f.orgId })).map((v: any) => [v.name, v.shared, v.editable])).toEqual([["Rae's deals", false, true]]);
    expect(await sam.client.query(views.list, { orgId: f.orgId })).toEqual([]);
    expect(await f.client.query(views.list, { orgId: f.orgId })).toEqual([]);
    expect(await errorOf(sam.client.mutation(views.update, { orgId: f.orgId, viewId: personal, name: "Mine now" }))).toBe("View not found");
    expect(await errorOf(sam.client.mutation(views.remove, { orgId: f.orgId, viewId: personal }))).toBe("View not found");
    expect((await f.call("GET", "/api/v1/views")).json.views).toEqual([]);
    expect((await f.call("GET", `/api/v1/views/${personal}/records`)).status).toBe(404);
    expect(await errorOf(rae.client.mutation(views.create, { ...base, name: "For all", shared: true }))).toBe("Only an admin can share a view");
    const shared = await f.client.mutation(views.create, { ...base, name: "For all", shared: true });
    expect((await sam.client.query(views.list, { orgId: f.orgId })).map((v: any) => [v._id, v.editable])).toEqual([[shared, false]]);
    expect(await errorOf(sam.client.mutation(views.remove, { orgId: f.orgId, viewId: shared }))).toBe("Only an admin can change a shared view");
    expect(await errorOf(sam.client.mutation(views.update, { orgId: f.orgId, viewId: shared, name: "Sam's now" }))).toBe("Only an admin can change a shared view");
    expect(await errorOf(sam.client.mutation(views.reorder, { orgId: f.orgId, viewIds: [shared] }))).toBe("Only an admin can change a shared view");
    expect((await sam.client.query(views.list, { orgId: f.orgId }))[0].name).toBe("For all");
  });

  it("can be renamed, reordered, pinned and deleted", async () => {
    const f = await pipeline();
    const make = (name: string) => f.client.mutation(views.create, { orgId: f.orgId, objectId: f.opp.object._id, name, layout: "table", columns: [], filters: [], shared: true });
    const a = await make("A"), b = await make("B"), c = await make("C");
    await f.client.mutation(views.update, { orgId: f.orgId, viewId: b, name: "Big deals", pinned: true });
    await f.client.mutation(views.reorder, { orgId: f.orgId, viewIds: [c, a, b] });
    expect((await f.client.query(views.list, { orgId: f.orgId })).map((v: any) => [v.name, v.pinned])).toEqual([["C", false], ["A", false], ["Big deals", true]]);
    await f.client.mutation(views.remove, { orgId: f.orgId, viewId: a });
    expect((await f.client.query(views.list, { orgId: f.orgId })).map((v: any) => v.name)).toEqual(["C", "Big deals"]);
    expect(await errorOf(f.client.mutation(views.update, { orgId: f.orgId, viewId: c, name: "  " }))).toBe("Name is required");
  });

  it("cannot be saved or changed while the workspace is read only, but can be deleted", async () => {
    const f = await pipeline();
    const viewId = await f.client.mutation(views.create, { orgId: f.orgId, objectId: f.opp.object._id, name: "Mine", layout: "table", columns: [], filters: [] });
    await f.t.run((ctx: any) => ctx.db.patch(f.orgId, { flags: { readonly: true } }));
    expect(await errorOf(f.client.mutation(views.create, { orgId: f.orgId, objectId: f.opp.object._id, name: "More", layout: "table", columns: [], filters: [] }))).toBe("Workspace is read only");
    expect(await errorOf(f.client.mutation(views.update, { orgId: f.orgId, viewId, name: "Renamed" }))).toBe("Workspace is read only");
    await f.client.mutation(views.remove, { orgId: f.orgId, viewId });
    expect(await f.client.query(views.list, { orgId: f.orgId })).toEqual([]);
  });

  it("keeps working when a field it uses is retired, with that column, filter and sort dropped and flagged", async () => {
    // Stage cannot be retired (features rely on it), so the board groups and filters by a custom select.
    const f = await pipeline(), { fieldId: tier } = await f.client.mutation(api.fields.create, { orgId: f.orgId, objectId: f.opp.object._id, key: "tier", label: "Tier", type: "select", options: [{ id: "gold", label: "Gold" }] });
    const viewId = await f.client.mutation(views.create, { orgId: f.orgId, objectId: f.opp.object._id, name: "Gold by size", layout: "board", groupFieldId: tier, columns: [f.o.amount._id, f.o.closeDate._id], filters: [{ fieldId: tier, value: "gold" }], sort: { fieldId: f.o.amount._id, direction: "desc" }, shared: true });
    expect((await f.call("GET", `/api/v1/views/${viewId}/records?limit=50`)).json.records).toHaveLength(0);
    await f.client.mutation(api.fields.retire, { orgId: f.orgId, fieldId: tier });
    await f.client.mutation(api.fields.retire, { orgId: f.orgId, fieldId: f.o.amount._id });
    const [view] = await f.client.query(views.list, { orgId: f.orgId });
    expect(view).toMatchObject({ layout: "table", columns: [f.o.closeDate._id], filters: [], blocked: false });
    expect(view.sort).toBeUndefined();
    expect(view.dropped).toEqual([{ field: "Amount", part: "column" }, { field: "Tier", part: "filter" }, { field: "Amount", part: "sort" }, { field: "Tier", part: "board" }]);
    const ran = await f.call("GET", `/api/v1/views/${viewId}/records?limit=50`);
    expect(ran.status).toBe(200);
    expect(ran.json.records).toHaveLength(6);
    expect(ran.json.view).toMatchObject({ layout: "table", columns: ["closeDate"], filters: [], sort: null, dropped: [{ field: "Amount", part: "column" }, { field: "Tier", part: "filter" }, { field: "Amount", part: "sort" }, { field: "Tier", part: "board" }] });
    // Saving the view again stores it without the retired fields.
    await f.client.mutation(views.update, { orgId: f.orgId, viewId, columns: [f.o.closeDate._id] });
    expect((await f.client.query(views.list, { orgId: f.orgId }))[0].dropped).toEqual([]);
  });

  it("is blocked, not widened, for a reader who cannot see its sort, range, board or calendar field", async () => {
    const f = await pipeline(), o = f.o, objectId = f.opp.object._id;
    const make = (name: string, spec: Record<string, unknown>) => f.client.mutation(views.create, { orgId: f.orgId, objectId, name, layout: "table", columns: [o.amount._id], filters: [], shared: true, ...spec });
    const made = {
      sorted: await make("By amount", { sort: { fieldId: o.amount._id, direction: "desc" } }),
      ranged: await make("March", { range: { fieldId: o.closeDate._id, from: "2026-03-01", to: "2026-03-31" } }),
      board: await make("Board", { layout: "board", groupFieldId: o.stage._id }),
      calendar: await make("Calendar", { layout: "calendar", dateFieldId: o.closeDate._id }),
      // A table view's group field lays nothing out, so it does not block the view.
      table: await make("Plain", { groupFieldId: o.stage._id }),
    };
    const agent = await f.client.action(api.agents.createScoped, { orgId: f.orgId, name: "names only", origin: "external" });
    await f.client.mutation(api.authority.grants.grant, { orgId: f.orgId, target: agent.agentId, capability: "read", scope: { kind: "records", objectId, records: "all", fields: [o.name._id] }, mode: "direct", delegate: false, expiresAt: Date.now() + 3600_000 });
    const call = rest(f.t, agent.key), listed = (await call("GET", "/api/v1/views?object=opportunity")).json.views;
    expect(listed.map((v: any) => [v.name, v.usable, v.columns, v.sort, v.range, v.groupBy, v.dateField])).toEqual([["By amount", false, [], null, null, null, null], ["March", false, [], null, null, null, null], ["Board", false, [], null, null, null, null], ["Calendar", false, [], null, null, null, null], ["Plain", true, [], null, null, null, null]]);
    expect(JSON.stringify(listed.map(({ name, ...rest }: any) => rest))).not.toMatch(/amount|stage|closeDate|2026-/);
    for (const id of [made.sorted, made.ranged, made.board, made.calendar]) expect((await call("GET", `/api/v1/views/${id}/records`)).status).toBe(403);
    expect((await call("GET", `/api/v1/views/${made.table}/records`)).status).toBe(200);
    const member = await joined(f, "Rae", "member");
    await f.client.mutation(anyApi["authority/policies"].setMember, { orgId: f.orgId, memberId: member.memberId, hiddenFieldIds: [o.amount._id, o.stage._id, o.closeDate._id] });
    const seen = await member.client.query(views.list, { orgId: f.orgId });
    expect(seen.map((v: any) => [v.name, v.blocked, v.columns, "sort" in v || "range" in v || "groupFieldId" in v || "dateFieldId" in v])).toEqual([["By amount", true, [], false], ["March", true, [], false], ["Board", true, [], false], ["Calendar", true, [], false], ["Plain", false, [], false]]);
  });

  it("are not listed or run on an object the reader cannot read", async () => {
    const f = await pipeline(), company = await objectFields(f.client, f.orgId, "company");
    const viewId = await f.client.mutation(views.create, { orgId: f.orgId, objectId: f.opp.object._id, name: "Pinned deals", layout: "table", columns: [], filters: [], shared: true, pinned: true });
    const member = await joined(f, "Rae", "member");
    await f.client.mutation(anyApi["authority/policies"].setMember, { orgId: f.orgId, memberId: member.memberId, scopes: [{ objectId: company.object._id, records: "all", fields: "all" }], hiddenFieldIds: [] });
    expect(await member.client.query(views.list, { orgId: f.orgId })).toEqual([]);
    expect(await errorOf(member.client.mutation(views.update, { orgId: f.orgId, viewId, name: "Mine" }))).toBe("View not found");
    const agent = await f.client.action(api.agents.createScoped, { orgId: f.orgId, name: "companies only", origin: "external" });
    await f.client.mutation(api.authority.grants.grant, { orgId: f.orgId, target: agent.agentId, capability: "read", scope: { kind: "records", objectId: company.object._id, records: "all", fields: [company.fields.name._id] }, mode: "direct", delegate: false, expiresAt: Date.now() + 3600_000 });
    const call = rest(f.t, agent.key);
    expect((await call("GET", "/api/v1/views")).json.views).toEqual([]);
    expect((await call("GET", "/api/v1/views?object=opportunity")).status).toBe(404);
    expect((await call("GET", `/api/v1/views/${viewId}/records`)).status).toBe(404);
  });

  it("refuses columns the saver cannot read, and pins only shared views", async () => {
    const f = await pipeline(), rae = await joined(f, "Rae", "member");
    await f.client.mutation(anyApi["authority/policies"].setMember, { orgId: f.orgId, memberId: rae.memberId, hiddenFieldIds: [f.o.amount._id] });
    const base = { orgId: f.orgId, objectId: f.opp.object._id, name: "Mine", layout: "table", filters: [] };
    expect(await errorOf(rae.client.mutation(views.create, { ...base, columns: [f.o.amount._id] }))).toBe("Field not found");
    expect(await errorOf(f.client.mutation(views.create, { ...base, columns: [], pinned: true }))).toBe("Only a shared view can be pinned");
    const personal = await f.client.mutation(views.create, { ...base, columns: [] });
    expect(await errorOf(f.client.mutation(views.update, { orgId: f.orgId, viewId: personal, pinned: true }))).toBe("Only a shared view can be pinned");
  });

  it("checks filter values like the agent path does", async () => {
    const f = await pipeline(), o = f.o;
    const save = (fieldId: string, value: unknown) => errorOf(f.client.mutation(views.create, { orgId: f.orgId, objectId: f.opp.object._id, name: "V", layout: "table", columns: [], filters: [{ fieldId, value }], shared: true }));
    const propose = async (field: string, value: unknown) => (await f.call("POST", "/api/v1/shape/proposals", { kind: "addView", object: "opportunity", name: "V", filters: [{ field, value }], reason: "r" })).json.error?.message ?? null;
    for (const [key, value] of [["stage", "nonsense"], ["amount", { a: 1 }], ["amount", "lots"], ["company", "no such company"]] as const) {
      const person = await save(o[key]._id, value);
      expect(person).toBeTruthy();
      expect(person).toBe(await propose(key, value));
    }
    // A person's values are stored the way the agent path stores them: an option label becomes its id.
    await f.client.mutation(views.create, { orgId: f.orgId, objectId: f.opp.object._id, name: "Labels", layout: "table", columns: [], filters: [{ fieldId: o.stage._id, value: "Proposal" }, { fieldId: o.amount._id, value: "900" }], shared: true });
    expect((await f.client.query(views.list, { orgId: f.orgId }))[0].filters).toEqual([{ fieldId: o.stage._id, value: "proposal" }, { fieldId: o.amount._id, value: 900 }]);
  });

  it("refuses an unknown time zone on every run, with or without dates", async () => {
    const f = await pipeline();
    const plain = await f.client.mutation(views.create, { orgId: f.orgId, objectId: f.opp.object._id, name: "Plain", layout: "table", columns: [], filters: [], shared: true });
    const fixed = await f.client.mutation(views.create, { orgId: f.orgId, objectId: f.opp.object._id, name: "Fixed", layout: "table", columns: [], filters: [], range: { fieldId: f.o.closeDate._id, from: "2026-03-01" }, shared: true });
    for (const id of [plain, fixed]) {
      const r = await f.call("GET", `/api/v1/views/${id}/records?tz=Nowhere/Land`);
      expect([r.status, r.json.error?.message]).toEqual([400, "Unknown time zone"]);
      expect((await f.call("GET", `/api/v1/views/${id}/records?tz=Asia/Tokyo`)).status).toBe(200);
    }
  });

  it("leaves views of an archived object out of lists and runs", async () => {
    const f = await pipeline();
    const viewId = await f.client.mutation(views.create, { orgId: f.orgId, objectId: f.opp.object._id, name: "Deals", layout: "table", columns: [], filters: [], shared: true, pinned: true });
    await f.t.run((ctx: any) => ctx.db.patch(f.opp.object._id, { archived: true }));
    expect(await f.client.query(views.list, { orgId: f.orgId })).toEqual([]);
    expect((await f.call("GET", "/api/v1/views")).json.views).toEqual([]);
    expect((await f.call("GET", `/api/v1/views/${viewId}/records`)).status).toBe(404);
  });
});

describe("agents propose views", () => {
  const propose = (call: ReturnType<typeof rest>, body: Record<string, unknown>) => call("POST", "/api/v1/shape/proposals", { kind: "addView", object: "opportunity", reason: "the team works from this", ...body });

  it("are refused by the same rules as a person saving the view", async () => {
    const f = await pipeline(), company = await objectFields(f.client, f.orgId, "company");
    const human = (spec: Record<string, unknown>, objectId = f.opp.object._id) => errorOf(f.client.mutation(views.create, { orgId: f.orgId, objectId, name: "View", layout: "table", columns: [], filters: [], shared: true, ...spec }));
    const agent = async (body: Record<string, unknown>) => { const r = await propose(f.call, { name: "View", layout: "table", ...body }); expect(r.status).toBeGreaterThanOrEqual(400); return r.json.error.message; };
    const filter = (key: string, value: unknown) => ({ fieldId: f.o[key]._id, value });
    const pairs: [Promise<unknown>, Promise<unknown>, string][] = [
      [human({ name: " " }), agent({ name: " " }), "Name is required"],
      [human({ filters: [filter("stage", "won"), filter("amount", 1), filter("company", null), filter("person", null)] }), agent({ filters: [{ field: "stage", value: "won" }, { field: "amount", value: 1 }, { field: "company", value: null }, { field: "person", value: null }] }), "At most 3 filters"],
      [human({ layout: "board" }), agent({ layout: "board" }), "A board view needs a select field to group by"],
      [human({ layout: "board", groupFieldId: f.o.amount._id }), agent({ layout: "board", groupBy: "amount" }), "A board view needs a select field to group by"],
      [human({ layout: "calendar" }), agent({ layout: "calendar" }), "A calendar view needs a date field"],
      [human({ range: { fieldId: f.o.amount._id, from: "2026-01-01" } }), agent({ range: { field: "amount", from: "2026-01-01" } }), "A range needs a date field"],
      [human({ range: { fieldId: f.o.closeDate._id, from: "2026-02-01", to: "2026-01-01" } }), agent({ range: { field: "closeDate", from: "2026-02-01", to: "2026-01-01" } }), "A range must start before it ends"],
      [human({ range: { fieldId: f.o.closeDate._id, from: "2026-02-30" } }), agent({ range: { field: "closeDate", from: "2026-02-30" } }), "Range dates must be YYYY-MM-DD"],
      [human({ range: { fieldId: f.o.closeDate._id, to: "March 1" } }), agent({ range: { field: "closeDate", to: "March 1" } }), "Range dates must be YYYY-MM-DD"],
      [human({ sort: { fieldId: company.fields.notes._id, direction: "asc" } }, company.object._id), agent({ object: "company", sort: { field: "notes", direction: "asc" } }), "Field is not indexed"],
    ];
    for (const [person, proposal, message] of pairs) expect([await person, await proposal]).toEqual([message, message]);
    expect(await f.client.query(views.list, { orgId: f.orgId })).toEqual([]);
    expect(await f.client.query(anyApi.shapeSuggestions.list, { orgId: f.orgId })).toEqual([]);
  });

  it("stays hidden from an admin who cannot read a field it names, and cannot be applied by them", async () => {
    const f = await pipeline(), ada = await joined(f, "Ada", "admin");
    await f.client.mutation(anyApi["authority/policies"].setMember, { orgId: f.orgId, memberId: ada.memberId, hiddenFieldIds: [f.o.amount._id] });
    const made = await propose(f.call, { name: "Big deals", columns: ["amount"] });
    expect(made.status).toBe(201);
    expect(await ada.client.query(anyApi.shapeSuggestions.list, { orgId: f.orgId })).toEqual([]);
    expect(await errorOf(ada.client.mutation(anyApi.shapeSuggestions.apply, { orgId: f.orgId, id: made.json.proposal.id }))).toBe("Proposal not found");
    expect((await f.client.query(anyApi.shapeSuggestions.list, { orgId: f.orgId })).map((r: any) => r.summary)).toEqual(["Add view Big deals to Opportunities"]);
    expect(await f.client.query(views.list, { orgId: f.orgId })).toEqual([]);
  });

  it("is applied by an admin from Suggestions and creates the shared view", async () => {
    const f = await pipeline();
    const made = await propose(f.call, { name: "Quotes needing follow-up", layout: "board", groupBy: "stage", columns: ["amount", "closeDate"], filters: [{ field: "stage", value: "Proposal" }], range: { field: "closeDate", relative: "next7" }, sort: { field: "amount", direction: "desc" }, pinned: true });
    expect(made.status).toBe(201);
    expect(made.json.proposal).toMatchObject({ kind: "addView", status: "pending", summary: "Add view Quotes needing follow-up to Opportunities" });
    expect(await f.client.query(views.list, { orgId: f.orgId })).toEqual([]);
    const [row] = await f.client.query(anyApi.shapeSuggestions.list, { orgId: f.orgId });
    expect(row.details).toEqual(["Board by Stage", "Columns: Amount, Close Date", "Stage is Proposal", "Close Date: next 7 days", "Sorted by Amount, high to low", "Pinned in the menu"]);
    expect(await f.client.mutation(anyApi.shapeSuggestions.apply, { orgId: f.orgId, id: row._id })).toMatchObject({ status: "applied" });
    const [view] = await f.client.query(views.list, { orgId: f.orgId });
    expect(view).toMatchObject({ name: "Quotes needing follow-up", layout: "board", groupFieldId: f.o.stage._id, columns: [f.o.amount._id, f.o.closeDate._id], filters: [{ fieldId: f.o.stage._id, value: "proposal" }], range: { fieldId: f.o.closeDate._id, relative: "next7" }, shared: true, pinned: true, createdBy: { kind: "agent", name: "reader" } });
    expect((await f.call("GET", "/api/v1/shape/proposals?status=applied")).json.proposals[0].result).toEqual({ object: "opportunity", fields: [], view: view._id });
    expect((await f.call("GET", "/api/v1/views?object=opportunity")).json.views.map((v: any) => v.name)).toEqual(["Quotes needing follow-up"]);
  });
});
