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
    await newDeal("First day", { stage: "new", campaign: spring, closeDate: "2026-10-01" });
    await newDeal("Last day", { stage: "new", campaign: spring, closeDate: "2026-10-31" });
    await newDeal("Day after", { stage: "new", campaign: spring, closeDate: "2026-11-01" });
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
    await client.mutation(anyApi["authority/policies"].setMember, { orgId, memberId, hiddenFieldIds: [deal.fields.closeDate._id, deal.fields.campaign._id] });
    const objectId = deal.object._id, stage = { fieldId: deal.fields.stage._id, value: "new" };
    const hiddenRange = { fieldId: deal.fields.closeDate._id, from: day("2026-10-01"), to: day("2026-10-31") }, hiddenFilter = { fieldId: deal.fields.campaign._id, value: spring };
    await expect(client.query(api.records.list, { orgId, objectId, filters: [stage], range: hiddenRange, paginationOpts: page })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await expect(client.query(api.records.list, { orgId, objectId, filters: [stage, hiddenFilter], paginationOpts: page })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await expect(client.query(api.records.totals, { orgId, objectId, groupFieldId: deal.fields.stage._id, filters: [hiddenFilter] })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await expect(client.query(api.csv.exportPage, { orgId, objectId, cursor: null, filters: [hiddenFilter] })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    expect((await client.query(api.records.list, { orgId, objectId, filters: [stage], paginationOpts: page })).page.map((r: any) => r.title)).toEqual(["Secret"]);
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
});
