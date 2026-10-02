import { describe, expect, it } from "vitest";
import { anyApi } from "convex/server";
import { internal } from "./_generated/api";
import { agentFor, api, objectFields, rest, userAndOrg } from "./test.helpers";

const page = { cursor: null, numItems: 100 };
const day = (text: string) => Date.parse(`${text}T00:00:00Z`);

async function funnels() {
  const f = await userAndOrg();
  const deal = await objectFields(f.client, f.orgId, "opportunity"), campaign = await objectFields(f.client, f.orgId, "campaign"), task = await objectFields(f.client, f.orgId, "task");
  const newCampaign = async (name: string) => (await f.client.mutation(api.records.create, { orgId: f.orgId, objectId: campaign.object._id, values: { [campaign.fields.name._id]: name } })).recordId;
  const newDeal = async (name: string, values: { stage?: string; amount?: number; campaign?: string; closeDate?: string }) => (await f.client.mutation(api.records.create, { orgId: f.orgId, objectId: deal.object._id, values: {
    [deal.fields.name._id]: name,
    ...(values.stage ? { [deal.fields.stage._id]: values.stage } : {}),
    ...(values.amount !== undefined ? { [deal.fields.amount._id]: values.amount } : {}),
    ...(values.campaign ? { [deal.fields.campaign._id]: values.campaign } : {}),
    ...(values.closeDate ? { [deal.fields.closeDate._id]: day(values.closeDate) } : {}),
  } })).recordId;
  return { ...f, deal, campaign, task, newCampaign, newDeal };
}

describe("funnels", () => {
  it("links an opportunity to its campaign through a standard indexed lookup", async () => {
    const { deal, campaign } = await funnels();
    expect(deal.fields.campaign).toMatchObject({ type: "lookup", targetObjectId: campaign.object._id, slot: { kind: "s" } });
    expect(deal.fields.source).toBeUndefined();
  });

  it("adds the campaign lookup to an older workspace, and a second run changes nothing", async () => {
    const { t, orgId, deal } = await funnels();
    await t.run(async (ctx) => ctx.db.delete(deal.fields.campaign._id));
    const snapshot = () => t.run(async (ctx) => ({ objects: await ctx.db.query("objects").collect(), fields: await ctx.db.query("fields").collect() }));
    await t.mutation(internal.seed.ensureStandard, { orgId });
    const once = await snapshot();
    expect(once.fields.find((field) => field.objectId === deal.object._id && field.key === "campaign")).toMatchObject({ type: "lookup", slot: { kind: "s" } });
    await t.mutation(internal.seed.ensureStandard, { orgId });
    expect(await snapshot()).toEqual(once);
  });

  it("board totals per stage equal a filtered export, for two funnels and for the whole board", async () => {
    const { client, orgId, deal, newCampaign, newDeal } = await funnels();
    const spring = await newCampaign("Spring webinar"), referral = await newCampaign("Referral push");
    await newDeal("S1", { stage: "new", amount: 1000, campaign: spring });
    await newDeal("S2", { stage: "new", amount: 250, campaign: spring });
    await newDeal("S3", { stage: "proposal", amount: 4000, campaign: spring });
    await newDeal("S4", { stage: "won", campaign: spring });
    await newDeal("S5", { amount: 75, campaign: spring });
    await newDeal("R1", { stage: "new", amount: 500, campaign: referral });
    await newDeal("R2", { stage: "won", amount: 9000, campaign: referral });
    await newDeal("Loose", { stage: "new", amount: 1, });
    const stage = deal.fields.stage, amount = deal.fields.amount;
    const fromExport = async (filters?: any[]) => {
      const sheet = await client.query(api.csv.exportPage, { orgId, objectId: deal.object._id, cursor: null, ...(filters ? { filters } : {}) });
      const at = (label: string) => sheet.header.indexOf(label);
      const out: Record<string, { count: number; sum: number }> = {};
      for (const row of sheet.rows) {
        const label = row[at("Stage")]!, id = stage.options.find((o: any) => o.label === label)?.id ?? "";
        out[id] ??= { count: 0, sum: 0 };
        out[id].count += 1; out[id].sum += Number(row[at("Amount")] || 0);
      }
      return out;
    };
    const fromBoard = async (filters?: any[]) => {
      const totals = await client.query(api.records.totals, { orgId, objectId: deal.object._id, groupFieldId: stage._id, sumFieldId: amount._id, ...(filters ? { filters } : {}) });
      expect(totals.partial).toBe(false);
      return Object.fromEntries(totals.groups.filter((g: any) => g.count > 0).map((g: any) => [g.value ?? "", { count: g.count, sum: g.sum }]));
    };
    for (const id of [spring, referral]) {
      const filters = [{ fieldId: deal.fields.campaign._id, value: id }];
      expect(await fromBoard(filters)).toEqual(await fromExport(filters));
    }
    expect(await fromBoard([{ fieldId: deal.fields.campaign._id, value: spring }])).toEqual({ new: { count: 2, sum: 1250 }, proposal: { count: 1, sum: 4000 }, won: { count: 1, sum: 0 }, "": { count: 1, sum: 75 } });
    expect(await fromBoard([{ fieldId: deal.fields.campaign._id, value: referral }])).toEqual({ new: { count: 1, sum: 500 }, won: { count: 1, sum: 9000 } });
    expect(await fromBoard()).toEqual(await fromExport());
  });

  it("combines two field filters with an inclusive date range, over REST and in the app", async () => {
    const { t, client, orgId, deal, task, newCampaign, newDeal } = await funnels();
    const spring = await newCampaign("Spring webinar"), referral = await newCampaign("Referral push");
    const first = await newDeal("First day", { stage: "new", campaign: spring, closeDate: "2026-10-01" });
    const last = await newDeal("Last day", { stage: "new", campaign: spring, closeDate: "2026-10-31" });
    const after = await newDeal("Day after", { stage: "new", campaign: spring, closeDate: "2026-11-01" });
    await newDeal("Day before", { stage: "new", campaign: spring, closeDate: "2026-09-30" });
    await newDeal("Other stage", { stage: "contacted", campaign: spring, closeDate: "2026-10-15" });
    await newDeal("Other funnel", { stage: "new", campaign: referral, closeDate: "2026-10-15" });
    await newDeal("No funnel", { stage: "new", closeDate: "2026-10-15" });
    await newDeal("No date", { stage: "new", campaign: spring });
    const call = rest(t, (await agentFor(client, orgId, { name: "reader" })).key);
    const listed = await call("GET", `/api/v1/records?object=opportunity&filter[stage]=new&filter[campaign]=${spring}&range[closeDate]=2026-10-01..2026-10-31`);
    expect(listed.status).toBe(200);
    expect(listed.json.records.map((r: any) => r.title).sort()).toEqual(["First day", "Last day"]);
    const walked: string[] = [];
    for (let cursor = ""; ;) {
      const next = await call("GET", `/api/v1/records?object=opportunity&filter[stage]=new&filter[campaign]=${spring}&range[closeDate]=2026-10-01..2026-10-31&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      walked.push(...next.json.records.map((r: any) => r.title));
      if (!next.json.cursor) break; cursor = next.json.cursor;
    }
    expect(walked.sort()).toEqual(["First day", "Last day"]);
    const filters = [{ fieldId: deal.fields.stage._id, value: "new" }, { fieldId: deal.fields.campaign._id, value: spring }];
    const range = { fieldId: deal.fields.closeDate._id, from: day("2026-10-01"), to: day("2026-10-31") };
    const app = await client.query(api.records.list, { orgId, objectId: deal.object._id, filters, range, paginationOpts: page });
    expect(app.page.map((r: any) => r.title)).toEqual(["First day", "Last day"]);
    const sorted = await client.query(api.records.list, { orgId, objectId: deal.object._id, filters, range, sort: { fieldId: deal.fields.closeDate._id, direction: "desc" }, paginationOpts: page });
    expect(sorted.page.map((r: any) => r.title)).toEqual(["Last day", "First day"]);
    // A with-time date: the last day of the range runs to its end, the next day's first minute is out.
    for (const [title, due] of [["Late on the 31st", "2026-10-31T23:59:00Z"], ["Midnight after", "2026-11-01T00:00:00Z"], ["Start", "2026-10-01T00:00:00Z"]] as const) await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: title, [task.fields.dueDate._id]: Date.parse(due) } });
    const tasks = await call("GET", "/api/v1/records?object=task&range[dueDate]=2026-10-01..2026-10-31");
    expect(tasks.json.records.map((r: any) => r.title)).toEqual(["Start", "Late on the 31st"]);
    expect((await call("GET", "/api/v1/records?object=task&range[dueDate]=2026-10-31..2026-10-01")).status).toBe(400);
    expect((await call("GET", "/api/v1/records?object=task&range[title]=2026-10-01..2026-10-31")).status).toBe(400);
    // A record-scoped reader gets the same answer from their own list, limited to what they hold.
    const memberId = await t.run(async (ctx) => (await ctx.db.query("members").collect())[0]!._id);
    await client.mutation(anyApi["authority/policies"].setMember, { orgId, memberId, scopes: [{ objectId: deal.object._id, records: [last, after, first], fields: "all" }], hiddenFieldIds: [] });
    expect((await client.query(api.records.list, { orgId, objectId: deal.object._id, filters, range, paginationOpts: page })).page.map((r: any) => r.title)).toEqual(["First day", "Last day"]);
    expect((await client.query(api.records.list, { orgId, objectId: deal.object._id, filters, range, sort: { fieldId: deal.fields.closeDate._id, direction: "desc" }, paginationOpts: page })).page.map((r: any) => r.title)).toEqual(["Last day", "First day"]);
  });

  it("refuses to filter, range, total or export by a field the caller cannot read", async () => {
    const { t, client, orgId, deal, newCampaign, newDeal } = await funnels();
    const spring = await newCampaign("Spring webinar");
    await newDeal("Secret", { stage: "new", amount: 5, campaign: spring, closeDate: "2026-10-05" });
    const agent = await agentFor(client, orgId, { name: "masked" }), call = rest(t, agent.key);
    await client.mutation(anyApi["authority/policies"].setAgentMasks, { orgId, agentId: agent.agentId, hiddenFieldIds: [deal.fields.closeDate._id, deal.fields.campaign._id] });
    expect((await call("GET", "/api/v1/records?object=opportunity&filter[stage]=new&range[closeDate]=2026-10-01..2026-10-31")).status).toBe(404);
    expect((await call("GET", `/api/v1/records?object=opportunity&filter[stage]=new&filter[campaign]=${spring}`)).status).toBe(404);
    expect((await call("GET", "/api/v1/records?object=opportunity&filter[stage]=new")).status).toBe(200);
    const memberId = await t.run(async (ctx) => (await ctx.db.query("members").collect())[0]!._id);
    await client.mutation(anyApi["authority/policies"].setMember, { orgId, memberId, hiddenFieldIds: [deal.fields.closeDate._id, deal.fields.campaign._id, deal.fields.amount._id] });
    const objectId = deal.object._id, stage = { fieldId: deal.fields.stage._id, value: "new" };
    const hiddenRange = { fieldId: deal.fields.closeDate._id, from: day("2026-10-01"), to: day("2026-10-31") }, hiddenFilter = { fieldId: deal.fields.campaign._id, value: spring };
    await expect(client.query(api.records.list, { orgId, objectId, filters: [stage], range: hiddenRange, paginationOpts: page })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await expect(client.query(api.records.list, { orgId, objectId, filters: [stage, hiddenFilter], paginationOpts: page })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await expect(client.query(api.records.totals, { orgId, objectId, groupFieldId: deal.fields.stage._id, filters: [hiddenFilter] })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await expect(client.query(api.csv.exportPage, { orgId, objectId, cursor: null, filters: [hiddenFilter] })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    expect((await client.query(api.records.list, { orgId, objectId, filters: [stage], paginationOpts: page })).page.map((r: any) => r.title)).toEqual(["Secret"]);
    // A hidden number is never summed: the board still counts, but shows no total.
    const counted = await client.query(api.records.totals, { orgId, objectId, groupFieldId: deal.fields.stage._id, sumFieldId: deal.fields.amount._id });
    expect(counted.groups.find((g: any) => g.value === "new")).toEqual({ value: "new", count: 1, sum: null });
  });

  it("shows a due funnel step on Today with the funnel's name", async () => {
    const { client, orgId, task, newCampaign } = await funnels();
    const spring = await newCampaign("Spring webinar");
    const company = await objectFields(client, orgId, "company");
    const acme = (await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: "Acme" } })).recordId;
    const today = day(new Date().toISOString().slice(0, 10));
    const step = (await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: "Send invite", [task.fields.dueDate._id]: today, [task.fields.about._id]: spring } })).recordId;
    const plain = (await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: "Call Acme", [task.fields.dueDate._id]: today, [task.fields.about._id]: acme } })).recordId;
    const data = await client.query(api.today.get, { orgId, today });
    expect(data.tasks.map((r: any) => r._id).sort()).toEqual([step, plain].sort());
    expect(data.funnels).toEqual({ [step]: { _id: spring, title: "Spring webinar" } });
  });

  it("matches a with-time range by the viewer's local days, all-day values by date, across DST", async () => {
    const f = await funnels(), { client, orgId, task } = f;
    const at = (text: string) => Date.parse(text);
    for (const [title, due] of [
      ["Outside September 30", at("2026-10-01T02:00:00Z")], // 10 PM Sep 30 in New York
      ["Inside October 1", at("2026-10-01T15:00:00Z")],
      ["All-day October 1", Date.UTC(2026, 9, 1)],
      ["All-day October 2", Date.UTC(2026, 9, 2)], // falls inside Oct 1 local time as an instant, but is a different date
      ["All-day September 30", Date.UTC(2026, 8, 30)],
      ["Inside November 1", at("2026-11-02T04:30:00Z")], // 11:30 PM Nov 1, the 25-hour day
      ["Outside November 2", at("2026-11-02T05:00:00Z")],
    ] as const) await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: title, [task.fields.dueDate._id]: due } });
    // What the app sends for New York local days (see dayRange in src/lib/fields.ts).
    const october1 = { fieldId: task.fields.dueDate._id, from: Date.UTC(2026, 9, 1, 4), to: Date.UTC(2026, 9, 2, 4) - 1, days: { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 1) } };
    const november1 = { fieldId: task.fields.dueDate._id, from: Date.UTC(2026, 10, 1, 4), to: Date.UTC(2026, 10, 2, 5) - 1, days: { from: Date.UTC(2026, 10, 1), to: Date.UTC(2026, 10, 1) } };
    const titles = async (range: any, sort?: any) => (await client.query(api.records.list, { orgId, objectId: task.object._id, range, ...(sort ? { sort } : {}), paginationOpts: page })).page.map((r: any) => r.title).sort();
    expect(await titles(october1)).toEqual(["All-day October 1", "Inside October 1"]);
    expect(await titles(november1)).toEqual(["Inside November 1"]);
    // The range as a re-check behind another index gives the same rows.
    expect(await titles(october1, { fieldId: task.fields.title._id, direction: "asc" })).toEqual(["All-day October 1", "Inside October 1"]);
    // An agent names local days with offset bounds; the calendar date written in each bound bounds all-day values.
    const call = rest(f.t, (await agentFor(client, orgId, { name: "reader" })).key);
    const viaRest = await call("GET", `/api/v1/records?object=task&range[dueDate]=${encodeURIComponent("2026-10-01T00:00:00-04:00..2026-10-01T23:59:59.999-04:00")}`);
    expect(viaRest.json.records.map((r: any) => r.title).sort()).toEqual(["All-day October 1", "Inside October 1"]);
    // A record-scoped reader is served from their own list with the same rule.
    const ids = (await client.query(api.records.list, { orgId, objectId: task.object._id, paginationOpts: page })).page.map((r: any) => r._id);
    const memberId = await f.t.run(async (ctx: any) => (await ctx.db.query("members").collect())[0]!._id);
    await client.mutation(anyApi["authority/policies"].setMember, { orgId, memberId, scopes: [{ objectId: task.object._id, records: ids, fields: "all" }], hiddenFieldIds: [] });
    expect(await titles(october1)).toEqual(["All-day October 1", "Inside October 1"]);
    expect(await titles(november1)).toEqual(["Inside November 1"]);
  });

  it("orders a funnel's steps by due date on the server before paging, undated last", async () => {
    const f = await funnels(), { client, orgId, task, newCampaign } = f;
    const spring = await newCampaign("Spring webinar"), other = await newCampaign("Other");
    const step = (title: string, about: string, due?: number) => client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: title, [task.fields.about._id]: about, ...(due !== undefined ? { [task.fields.dueDate._id]: due } : {}) } });
    await step("Undated", spring);
    for (let i = 0; i < 30; i += 1) await step(`Future ${i}`, spring, Date.UTC(2026, 11, 1) + i);
    await step("Urgent", spring, Date.UTC(2026, 9, 1, 13));
    await step("Not this funnel", other, Date.UTC(2026, 8, 1));
    const first = await client.query(api.records.steps, { orgId, recordId: spring, paginationOpts: { cursor: null, numItems: 10 } });
    expect(first.page.map((r: any) => r.title).slice(0, 3)).toEqual(["Urgent", "Future 0", "Future 1"]);
    const all = await client.query(api.records.steps, { orgId, recordId: spring, paginationOpts: { cursor: null, numItems: 100 } });
    expect(all.page).toHaveLength(32);
    expect(all.page.at(-1)!.title).toBe("Undated");
    // With the due date hidden, steps come in creation order: their order never reveals it.
    const memberId = await f.t.run(async (ctx: any) => (await ctx.db.query("members").collect())[0]!._id);
    await client.mutation(anyApi["authority/policies"].setMember, { orgId, memberId, hiddenFieldIds: [task.fields.dueDate._id] });
    expect((await client.query(api.records.steps, { orgId, recordId: spring, paginationOpts: { cursor: null, numItems: 3 } })).page.map((r: any) => r.title)).toEqual(["Undated", "Future 0", "Future 1"]);
  });

  it("flags board totals as partial past the cap and says where it stopped", async () => {
    const { t, client, orgId, deal } = await funnels();
    const stage = deal.fields.stage, slot = `${stage.slot.kind}${stage.slot.index}`;
    await t.run(async (ctx: any) => { for (let i = 0; i < 4001; i += 1) await ctx.db.insert("records", { orgId, objectId: deal.object._id, values: { [deal.fields.name._id]: `D${i}`, [stage._id]: "new" }, title: `D${i}`, createdBy: (await ctx.db.query("users").first())._id, updatedAt: 0, [slot]: "new" }); });
    const totals = await client.query(api.records.totals, { orgId, objectId: deal.object._id, groupFieldId: stage._id });
    expect(totals).toMatchObject({ partial: true, cap: 4000 });
    expect(totals.groups.find((g: any) => g.value === "new")!.count).toBe(4000);
  }, 60000);

  it("treats an ISO midnight bound like the bare date, on a plain and on a with-time date field", async () => {
    const f = await funnels(), { client, orgId, task, newDeal } = f;
    await newDeal("First day", { stage: "new", closeDate: "2026-10-01" });
    await newDeal("Last day", { stage: "new", closeDate: "2026-10-31" });
    await newDeal("Day before", { stage: "new", closeDate: "2026-09-30" });
    for (const [title, due] of [["All-day first", Date.UTC(2026, 9, 1)], ["At midnight", Date.UTC(2026, 9, 1) + 0.5], ["Evening before", "2026-09-30T23:59:00Z"]] as const)
      await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: title, [task.fields.dueDate._id]: typeof due === "string" ? Date.parse(due) : due } });
    const call = rest(f.t, (await agentFor(client, orgId, { name: "reader" })).key);
    const titles = async (query: string) => { const r = await call("GET", `/api/v1/records?${query}`); expect(r.status).toBe(200); return r.json.records.map((x: any) => x.title).sort(); };
    const deals = await titles("object=opportunity&range[closeDate]=2026-10-01..2026-10-31");
    expect(deals).toEqual(["First day", "Last day"]);
    expect(await titles(`object=opportunity&range[closeDate]=${encodeURIComponent("2026-10-01T00:00:00Z..2026-10-31T23:59:59.999Z")}`)).toEqual(deals);
    expect(await titles("object=opportunity&range[closeDate]=..2026-10-01")).toEqual(["Day before", "First day"]);
    expect(await titles(`object=opportunity&range[closeDate]=${encodeURIComponent("..2026-10-01T00:00:00Z")}`)).toEqual(["Day before", "First day"]);
    const tasks = await titles("object=task&range[dueDate]=2026-10-01..2026-10-01");
    expect(tasks).toEqual(["All-day first", "At midnight"]);
    expect(await titles(`object=task&range[dueDate]=${encodeURIComponent("2026-10-01T00:00:00Z..2026-10-01T23:59:59.999Z")}`)).toEqual(tasks);
    // An instant at 00:00Z is stored as midnight + 0.5 ms; an inclusive upper bound at that midnight still holds it.
    expect(await titles(`object=task&range[dueDate]=${encodeURIComponent("2026-09-30T23:59:59Z..2026-10-01T00:00:00Z")}`)).toEqual(["All-day first", "At midnight"]);
    const upTo = { fieldId: task.fields.dueDate._id, from: Date.UTC(2026, 8, 30, 23, 59, 59), to: Date.UTC(2026, 9, 1) };
    const app = async (sort?: any) => (await client.query(api.records.list, { orgId, objectId: task.object._id, range: upTo, ...(sort ? { sort } : {}), paginationOpts: { cursor: null, numItems: 50 } })).page.map((r: any) => r.title).sort();
    expect(await app()).toEqual(["All-day first", "At midnight"]);
    expect(await app({ fieldId: task.fields.title._id, direction: "asc" })).toEqual(["All-day first", "At midnight"]);
    const ids = (await client.query(api.records.list, { orgId, objectId: task.object._id, paginationOpts: { cursor: null, numItems: 50 } })).page.map((r: any) => r._id);
    const memberId = await f.t.run(async (ctx: any) => (await ctx.db.query("members").collect())[0]!._id);
    await client.mutation(anyApi["authority/policies"].setMember, { orgId, memberId, scopes: [{ objectId: task.object._id, records: ids, fields: "all" }], hiddenFieldIds: [] });
    expect(await app()).toEqual(["All-day first", "At midnight"]);
  });

  it("pages every step in due order through an index, an urgent step after 1,000 others first", async () => {
    const f = await funnels(), { t, client, orgId, task, newCampaign } = f;
    const spring = await newCampaign("Spring webinar");
    const slot = (field: any) => `${field.slot.kind}${field.slot.index}`;
    // Direct inserts with the same values and slot projections applyChange writes, to keep the test fast.
    await t.run(async (ctx: any) => {
      const user = (await ctx.db.query("users").first())._id;
      for (let i = 0; i < 1000; i += 1) { const due = Date.UTC(2026, 11, 1) + i * 60000; await ctx.db.insert("records", { orgId, objectId: task.object._id, values: { [task.fields.title._id]: `Future ${i}`, [task.fields.about._id]: spring, [task.fields.dueDate._id]: due }, title: `Future ${i}`, createdBy: user, updatedAt: 0, [slot(task.fields.title)]: `Future ${i}`, [slot(task.fields.about)]: spring, [slot(task.fields.dueDate)]: due }); }
    });
    await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: "Undated", [task.fields.about._id]: spring } });
    await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: "Urgent", [task.fields.about._id]: spring, [task.fields.dueDate._id]: Date.UTC(2026, 9, 1, 13) } });
    const seen: string[] = [];
    let cursor: string | null = null, first: string | undefined;
    for (let pages = 0; pages < 100; pages += 1) {
      const result: any = await client.query(api.records.steps, { orgId, recordId: spring, paginationOpts: { cursor, numItems: 150 } });
      first ??= result.page[0]?.title;
      seen.push(...result.page.map((r: any) => r.title));
      if (result.isDone) break; cursor = result.continueCursor;
    }
    expect(first).toBe("Urgent");
    expect(seen).toHaveLength(1002);
    expect(new Set(seen).size).toBe(1002);
    expect(seen[1]).toBe("Future 0");
    expect(seen.at(-2)).toBe("Future 999");
    expect(seen.at(-1)).toBe("Undated");
  }, 60000);
});
