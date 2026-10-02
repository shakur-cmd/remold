import { describe, expect, it } from "vitest";
import { anyApi } from "convex/server";
import { internal } from "./_generated/api";
import { agentFor, api, objectFields, rest, userAndOrg } from "./test.helpers";

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const TODAY = day("2026-10-01");

async function world() {
  const f = await userAndOrg();
  const company = await objectFields(f.client, f.orgId, "company"), invoice = await objectFields(f.client, f.orgId, "invoice");
  const companyNamed = async (name: string): Promise<any> => (await f.client.mutation(api.records.create, { orgId: f.orgId, objectId: company.object._id, values: { [company.fields.name._id]: name } })).recordId;
  const bill = async (values: Record<string, unknown>): Promise<any> => (await f.client.mutation(api.records.create, { orgId: f.orgId, objectId: invoice.object._id, values: Object.fromEntries(Object.entries(values).map(([key, value]) => [invoice.fields[key]._id, value])) })).recordId;
  return { ...f, company, invoice, companyNamed, bill };
}

async function metadata(t: any, orgId: any) {
  return t.run(async (ctx: any) => ({ objects: await ctx.db.query("objects").withIndex("by_org", (q: any) => q.eq("orgId", orgId)).collect(), fields: await ctx.db.query("fields").collect() }));
}

describe("invoices", () => {
  it("every org has an Invoice object with the tracking fields, and paid on is protected from agents", async () => {
    const w = await world();
    expect(w.invoice.object.label).toBe("Invoice");
    expect(Object.fromEntries(Object.values(w.invoice.fields).map((f: any) => [f.key, f.type]))).toEqual({ number: "text", company: "lookup", amount: "number", sent: "date", due: "date", paidOn: "date", monthly: "boolean", document: "text" });
    expect(w.invoice.object.titleFieldId).toBe(w.invoice.fields.number._id);
    expect(w.invoice.fields.company.targetObjectId).toBe(w.company.object._id);
    expect(w.invoice.fields.paidOn.protectedFromAgents).toBe(true);
    expect(Object.values(w.invoice.fields).filter((f: any) => f.protectedFromAgents).map((f: any) => f.key)).toEqual(["paidOn"]);
  });

  it("an org created before invoices gains the object once, and running the migration again changes nothing", async () => {
    const { t, client, orgId } = await userAndOrg();
    const company = await objectFields(client, orgId, "company");
    await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: "Kept Co" } });
    await t.run(async (ctx: any) => {
      const invoice = await ctx.db.query("objects").withIndex("by_org_key", (q: any) => q.eq("orgId", orgId).eq("key", "invoice")).unique();
      for (const field of await ctx.db.query("fields").withIndex("by_object", (q: any) => q.eq("orgId", orgId).eq("objectId", invoice._id)).collect()) await ctx.db.delete(field._id);
      await ctx.db.delete(invoice._id);
    });
    const old = await metadata(t, orgId), records = await t.run((ctx: any) => ctx.db.query("records").collect());
    expect(old.objects.some((o: any) => o.key === "invoice")).toBe(false);
    await t.mutation(internal.seed.ensureStandard, { orgId });
    const once = await metadata(t, orgId);
    expect(once.objects.some((o: any) => o.key === "invoice")).toBe(true);
    for (const before of old.objects) expect(once.objects.find((o: any) => o._id === before._id)).toEqual(before);
    for (const before of old.fields) expect(once.fields.find((f: any) => f._id === before._id)).toEqual(before);
    expect(await t.run((ctx: any) => ctx.db.query("records").collect())).toEqual(records);
    await t.mutation(internal.seed.ensureStandard, { orgId });
    expect(await metadata(t, orgId)).toEqual(once);
  });

  it("a company's open balance equals the hand sum of its unpaid invoices", async () => {
    const w = await world(), acme = await w.companyNamed("Acme"), other = await w.companyNamed("Other");
    await w.bill({ number: "INV-1", company: acme, amount: 1200, due: day("2026-08-01"), paidOn: day("2026-08-03") });
    await w.bill({ number: "INV-2", company: acme, amount: 450.5, due: day("2026-09-01") });
    await w.bill({ number: "INV-3", company: acme, amount: 300, due: day("2026-10-15"), monthly: true });
    await w.bill({ number: "INV-4", company: acme, amount: 99.5, due: day("2026-09-10"), paidOn: day("2026-09-09"), monthly: true });
    await w.bill({ number: "INV-5", company: acme });
    await w.bill({ number: "INV-6", company: other, amount: 5000 });
    const totals = await w.client.query(api.invoices.forCompany, { orgId: w.orgId, recordId: acme });
    expect(totals).toMatchObject({ objectKey: "invoice", billed: 1200 + 450.5 + 300 + 99.5, paid: 1200 + 99.5, open: 450.5 + 300 });
    expect(totals!.invoices.map((r: any) => r.title).sort()).toEqual(["INV-1", "INV-2", "INV-3", "INV-4", "INV-5"]);
    expect(await w.client.query(api.invoices.forCompany, { orgId: w.orgId, recordId: other })).toMatchObject({ billed: 5000, paid: 0, open: 5000 });
  });

  it("an unpaid invoice past due shows on Today and drops off once paid on is set", async () => {
    const w = await world(), acme = await w.companyNamed("Acme");
    const late = await w.bill({ number: "LATE", company: acme, amount: 100, due: day("2026-09-20") });
    await w.bill({ number: "DUE-TODAY", company: acme, amount: 100, due: TODAY });
    await w.bill({ number: "PAID-LATE", company: acme, amount: 100, due: day("2026-09-01"), paidOn: day("2026-09-25") });
    await w.bill({ number: "NO-DUE", company: acme, amount: 100 });
    const listed = async () => (await w.client.query(api.today.get, { orgId: w.orgId, today: TODAY })).invoices.map((r: any) => r.title);
    expect(await listed()).toEqual(["LATE"]);
    await w.client.mutation(api.records.update, { orgId: w.orgId, recordId: late, values: { [w.invoice.fields.paidOn._id]: TODAY } });
    expect(await listed()).toEqual([]);
  });

  it("an agent without grants proposes an invoice, and no agent can set paid on", async () => {
    const w = await world(), acme = await w.companyNamed("Acme");
    const proposer = rest(w.t, (await agentFor(w.client, w.orgId, { name: "biller" })).key);
    expect((await proposer("POST", "/api/v1/changes", { action: "create", object: "invoice", values: { number: "AG-1", company: acme, amount: 10 }, reason: "direct" })).status).toBe(403);
    expect((await proposer("POST", "/api/v1/suggestions", { action: "create", object: "invoice", values: { number: "AG-1", company: acme, amount: 10, due: "2026-10-31" }, reason: "new invoice" })).status).toBeLessThan(300);
    const pending = await w.client.query(api.suggestions.list, { orgId: w.orgId, status: "pending" });
    expect(pending).toHaveLength(1);
    expect((await w.client.query(api.invoices.forCompany, { orgId: w.orgId, recordId: acme }))!.invoices).toEqual([]);
    expect((await proposer("POST", "/api/v1/suggestions", { action: "create", object: "invoice", values: { number: "AG-2", company: acme, paidOn: "2026-10-01" }, reason: "paid" })).status).toBe(403);

    const granted = rest(w.t, (await agentFor(w.client, w.orgId, { name: "bookkeeper", grants: [{ action: "create", objectKey: "invoice" }, { action: "update", objectKey: "invoice" }] })).key);
    const id = (await granted("POST", "/api/v1/changes", { action: "create", object: "invoice", values: { number: "AG-3", company: acme, amount: 20, due: "2026-09-01" }, reason: "granted" })).json.record?.id;
    expect(id).toBeTruthy();
    const paid = await granted("POST", "/api/v1/changes", { action: "update", record: id, values: { paidOn: "2026-10-01" }, reason: "mark paid" });
    expect(paid.status).toBe(403);
    expect(paid.json.error.message).toMatch(/protected/i);
    expect((await granted("POST", "/api/v1/suggestions", { action: "update", record: id, values: { paidOn: "2026-10-01" }, reason: "mark paid" })).status).toBe(403);
    expect((await granted("POST", "/api/v1/changes", { action: "create", object: "invoice", values: { number: "AG-4", paidOn: "2026-10-01" }, reason: "pre-paid" })).status).toBe(403);
    expect(((await w.t.run((ctx: any) => ctx.db.get(id))) as any).values[w.invoice.fields.paidOn._id]).toBeUndefined();
    expect((await granted("POST", "/api/v1/changes", { action: "update", record: id, values: { amount: 25 }, reason: "fix amount" })).status).toBe(200);
  });

  it("a company's invoice totals never show hidden amounts or invoices outside the caller's scope", async () => {
    const setup = async () => {
      const w = await world(), acme = await w.companyNamed("Acme");
      const seen = await w.bill({ number: "SEEN", company: acme, amount: 70, due: day("2026-09-01") });
      await w.bill({ number: "UNSEEN", company: acme, amount: 9001, due: day("2026-09-01") });
      const memberId = await w.t.run(async (ctx: any) => (await ctx.db.query("members").collect())[0]._id);
      return { w, acme, seen, policy: (args: Record<string, unknown>) => w.client.mutation(anyApi["authority/policies"].setMember, { orgId: w.orgId, memberId, ...args }) };
    };
    const masked = await setup();
    await masked.policy({ hiddenFieldIds: [masked.w.invoice.fields.amount._id] });
    const hidden = await masked.w.client.query(api.invoices.forCompany, { orgId: masked.w.orgId, recordId: masked.acme });
    expect(hidden).toMatchObject({ billed: null, paid: null, open: null });
    expect(hidden!.invoices).toHaveLength(2);
    expect(JSON.stringify(hidden)).not.toMatch(/9001|:70\b/);
    const { w, acme, seen, policy } = await setup();
    await policy({ hiddenFieldIds: [], scopes: [{ objectId: w.company.object._id, records: [acme], fields: "all" }, { objectId: w.invoice.object._id, records: [seen], fields: "all" }] });
    const scoped = await w.client.query(api.invoices.forCompany, { orgId: w.orgId, recordId: acme });
    expect(scoped!.invoices.map((r: any) => r.title)).toEqual(["SEEN"]);
    expect(scoped).toMatchObject({ billed: 70, paid: 0, open: 70 });
    expect((await w.client.query(api.today.get, { orgId: w.orgId, today: TODAY })).invoices.map((r: any) => r.title)).toEqual(["SEEN"]);
  });
});
