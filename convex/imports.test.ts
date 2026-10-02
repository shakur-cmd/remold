import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import { api, objectFields, userAndOrg } from "./test.helpers";
import { standard } from "./lib/standard";
import { importFields } from "./lib/importCheck";

const clients = {
  records: [
    { tmpId: "c1", object: "company", values: { name: "Harbor Bakery", domain: "harborbakery.example" }, sources: ["call notes"] },
    { tmpId: "p1", object: "person", values: { name: "Rosa Lin", email: "rosa@harborbakery.example", company: "@c1" } },
    { tmpId: "o1", object: "opportunity", values: { name: "Harbor website", stage: "proposal", amount: 2400, company: "@c1", person: "@p1" } },
    { tmpId: "pr1", object: "project", values: { name: "Harbor launch", status: "active", company: "@c1" } },
    { tmpId: "t1", object: "task", values: { title: "Send proposal", done: false, about: "@o1", due: "2026-11-30", project: "@pr1" } },
    { tmpId: "t2", object: "task", values: { title: "Book kickoff", blockedBy: ["@t1"] } },
    { tmpId: "n1", object: "note", values: { body: "Prefers texts after 5pm", about: "@p1" } },
  ],
};

async function count(t: any, orgId: any) {
  return t.run(async (ctx: any) => ({ records: (await ctx.db.query("records").collect()).filter((r: any) => r.orgId === orgId).length, events: (await ctx.db.query("events").collect()).length }));
}
const get = (client: any, orgId: any, recordId: string) => client.query(api.records.get, { orgId, recordId }).then((r: any) => r.record);

describe("client import", () => {
  it("imports a batch with every @reference linked to the record it names", async () => {
    const { t, client, orgId } = await userAndOrg();
    const result = await t.mutation(internal.imports.batch, { orgId, batch: clients });
    expect(result.status).toBe("imported");
    expect(result.counts).toEqual({ company: 1, person: 1, opportunity: 1, project: 1, task: 2, note: 1 });
    const ids = result.ids!;
    const person = await objectFields(client, orgId, "person"), opportunity = await objectFields(client, orgId, "opportunity"), task = await objectFields(client, orgId, "task"), note = await objectFields(client, orgId, "note");
    expect((await get(client, orgId, ids.p1)).values[person.fields.company._id]).toBe(ids.c1);
    const deal = await get(client, orgId, ids.o1);
    expect([deal.values[opportunity.fields.company._id], deal.values[opportunity.fields.person._id], deal.values[opportunity.fields.stage._id]]).toEqual([ids.c1, ids.p1, "proposal"]);
    const first = await get(client, orgId, ids.t1);
    expect([first.values[task.fields.about._id], first.values[task.fields.project._id], first.values[task.fields.dueDate._id], first.values[task.fields.done._id]]).toEqual([ids.o1, ids.pr1, Date.UTC(2026, 10, 30), false]);
    expect((await get(client, orgId, ids.t2)).values[task.fields.blockedBy._id]).toEqual([ids.t1]);
    expect((await get(client, orgId, ids.n1)).values[note.fields.about._id]).toBe(ids.p1);
    const [created] = await client.query(api.events.forRecord, { orgId, recordId: ids.c1 });
    expect(created).toMatchObject({ action: "create", actor: { kind: "automation" }, actorName: `import ${new Date().toISOString().slice(0, 10)}` });
  });

  it("creates nothing when the same batch runs again", async () => {
    const { t, orgId } = await userAndOrg();
    await t.mutation(internal.imports.batch, { orgId, batch: clients });
    const before = await count(t, orgId);
    const again = await t.mutation(internal.imports.batch, { orgId, batch: clients });
    expect(again).toMatchObject({ status: "already imported", counts: { task: 2 } });
    expect(await count(t, orgId)).toEqual(before);
  });

  it("refuses the whole batch, writing nothing, when a reference, key or value is bad", async () => {
    const { t, orgId } = await userAndOrg();
    const before = await count(t, orgId);
    const swap = (tmpId: string, values: Record<string, unknown>) => ({ records: clients.records.map((r) => (r.tmpId === tmpId ? { ...r, values } : r)) });
    await expect(t.mutation(internal.imports.batch, { orgId, batch: swap("n1", { body: "x", about: "@nobody" }) })).rejects.toMatchObject({ data: { code: "VALIDATION", message: expect.stringContaining('n1.about: "@nobody" is not an earlier record') } });
    await expect(t.mutation(internal.imports.batch, { orgId, batch: swap("p1", { name: "Rosa", favouriteColour: "red", shoe: 9 }) })).rejects.toMatchObject({ data: { message: expect.stringMatching(/p1 \(person\): unknown keys "favouriteColour", "shoe"; known keys: name, email/) } });
    // Only the server sees this one, after six records were already written in the transaction.
    await expect(t.mutation(internal.imports.batch, { orgId, batch: swap("t2", { title: "x", done: "maybe" }) })).rejects.toMatchObject({ data: { code: "VALIDATION", message: expect.stringContaining("t2 (task).done: Expected boolean") } });
    await expect(t.mutation(internal.imports.batch, { orgId, batch: swap("p1", { name: "Rosa", company: "@o1" }) })).rejects.toMatchObject({ data: { message: expect.stringContaining("p1.company") } });
    expect(await count(t, orgId)).toEqual(before);
  });

  it("refuses values that look like credentials without echoing them", async () => {
    const { t, orgId } = await userAndOrg();
    for (const body of ["wifi password is hunter2", "key sk_live_abc123", "token: 9f8e7d6c5b4a39281706f5e4d3c2b1a0aa", "aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldCBrZXk1MjM0NQ", "Their API key: x"]) {
      const error = await t.mutation(internal.imports.batch, { orgId, batch: { records: [{ tmpId: "n1", object: "note", values: { body } }] } }).catch((e: any) => e);
      expect(error.data?.message, body).toContain("n1.body: looks like a credential");
      expect(error.data.message).not.toContain(body);
    }
    expect((await count(t, orgId)).records).toBe(0);
    const fine = { records: [{ tmpId: "n1", object: "note", values: { body: "See linkedin.com/in/rosa-lin-bakery-owner-portland and rosa@harbor.example" } }] };
    expect((await t.mutation(internal.imports.batch, { orgId, batch: fine })).status).toBe("imported");
  });

  it("dry run counts against the live schema and writes nothing", async () => {
    const { t, orgId } = await userAndOrg();
    const before = await count(t, orgId);
    expect(await t.query(internal.imports.check, { orgId, batch: clients })).toMatchObject({ status: "ready", counts: { task: 2, company: 1 } });
    expect(await count(t, orgId)).toEqual(before);
    await expect(t.query(internal.imports.check, { orgId, batch: { records: [{ tmpId: "o1", object: "opportunity", values: { name: "x", stage: "someday" } }] } })).rejects.toMatchObject({ data: { message: expect.stringContaining("o1 (opportunity).stage: Invalid select option") } });
    await expect(t.query(internal.imports.check, { orgId, batch: { records: [{ tmpId: "c1", object: "company", values: { name: "x" } }, { tmpId: "p1", object: "person", values: { name: "y", company: "@c1" } }, { tmpId: "o1", object: "opportunity", values: { name: "z", person: "@c1" } }] } })).rejects.toMatchObject({ data: { message: expect.stringContaining("o1.person: @c1 is a company, not a person") } });
    await t.mutation(internal.imports.batch, { orgId, batch: clients });
    expect((await t.query(internal.imports.check, { orgId, batch: clients })).status).toBe("already imported");
  });

  it("knows the same keys and links the server's standard objects define", () => {
    for (const [object, fields] of Object.entries(importFields)) {
      const definition = standard.find((d) => d.key === object)!;
      expect(Object.fromEntries(definition.fields.map((f) => [f.key, f.type === "lookup" ? f.target ?? "*" : f.type === "links" ? `${f.target}[]` : ""])), object).toEqual(fields);
    }
  });
});
