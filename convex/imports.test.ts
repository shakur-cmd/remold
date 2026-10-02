import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import { api, objectFields, userAndOrg } from "./test.helpers";
import { standard } from "./lib/standard";
import { checkBatch, importFields } from "./lib/importCheck";

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
    for (const body of ["wifi password is hunter2", "key sk_live_abc123", "token: 9f8e7d6c5b4a39281706f5e4d3c2b1a0aa", "aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldCBrZXk1MjM0NQ", "Their API key: x", "deadbeef".repeat(8), "/".repeat(64)]) {
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

  it("dry run refuses exactly what the import refuses, with the same message", async () => {
    const { t, client, orgId } = await userAndOrg();
    const person = await objectFields(client, orgId, "person");
    await t.run((ctx: any) => ctx.db.patch(person.fields.company._id, { retired: true }));
    const cases = {
      retiredLookup: [{ tmpId: "c", object: "company", values: { name: "C" } }, { tmpId: "p", object: "person", values: { name: "P", company: "@c" } }],
      linksNotAList: [{ tmpId: "t1", object: "task", values: { title: "A" } }, { tmpId: "t2", object: "task", values: { title: "B", blockedBy: "@t1" } }],
      missingTitle: [{ tmpId: "n", object: "note", values: { about: null } }],
      badOption: [{ tmpId: "o", object: "opportunity", values: { name: "O", stage: "someday" } }],
    };
    for (const [name, records] of Object.entries(cases)) {
      const dry = await t.query(internal.imports.check, { orgId, batch: { records } }).then(() => "ready", (e: any) => e.data?.message);
      const real = await t.mutation(internal.imports.batch, { orgId, batch: { records } }).then(() => "imported", (e: any) => e.data?.message);
      expect(dry, name).not.toBe("ready");
      expect(dry, name).toBe(real);
    }
    await t.run(async (ctx: any) => ctx.db.patch(orgId, { flags: { readonly: true } }));
    const records = [{ tmpId: "c", object: "company", values: { name: "C" } }];
    const dry = await t.query(internal.imports.check, { orgId, batch: { records } }).then(() => "ready", (e: any) => e.data?.message);
    expect(dry).toBe(await t.mutation(internal.imports.batch, { orgId, batch: { records } }).then(() => "imported", (e: any) => e.data?.message));
  });

  it("refuses any unbroken 40+ character base64, base64url or hex run unless it is a path or URL", () => {
    const body = (text: string) => checkBatch({ records: [{ tmpId: "n", object: "note", values: { body: text } }] }).problems;
    for (const secret of ["deadbeef".repeat(8), "/".repeat(64), "harbor-bakery-website-redesign-final-draft", "YWJjZGVm".repeat(8), "aGVsbG8v/d29ybGQr/YWJjZGVmZ2hpams+/YWJjZGVm", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyb3NhIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"]) expect(body(`value ${secret}`), secret).toEqual([expect.stringContaining("looks like a credential")]);
    for (const fine of ["https://www.linkedin.com/in/rosa-lin-bakery-owner-portland", "/Users/Shakur/Documents/Clients/Harbor Bakery/Proposal Final.pdf", "https://example.com/blog/how-we-rebuilt-the-harbor-bakery-website-in-two-weeks", "HarborBakeryWebsiteRedesignProject",
      "/Users/Shakur/Documents/Clients/Harbor-Bakery/Website-Proposal-Final-Draft-v2.pdf", "~/Documents/clients/harbor-bakery/website_proposal_final_draft_2026.md",
      "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdef/edit", "see (docs.example.com/projects/harbor-bakery-website-redesign-final-draft)"]) expect(body(fine), fine).toEqual([]);
  });

  it("does not take object, alias or field names from the object prototype", () => {
    expect(checkBatch({ records: [{ tmpId: "x", object: "constructor", values: {} }] }).problems).toEqual([expect.stringContaining('x: unknown object "constructor"')]);
    expect(checkBatch({ records: [{ tmpId: "x", object: "note", values: { body: "b", toString: "y" } }] }).problems).toEqual([expect.stringContaining('unknown keys "toString"')]);
    expect(checkBatch({ records: [{ tmpId: "x", object: "task", values: { title: "b", constructor: "y" } }] }).problems).toEqual([expect.stringContaining('unknown keys "constructor"')]);
  });

  it("dry run applies the write's creation scope and required-field checks; a retired required field blocks neither", async () => {
    const { t, client, orgId } = await userAndOrg();
    const company = await objectFields(client, orgId, "company");
    const records = [{ tmpId: "c", object: "company", values: { name: "Scoped" } }];
    const dry = () => t.query(internal.imports.check, { orgId, batch: { records } }).then(() => "ready", (e: any) => e.data?.message);
    const real = () => t.mutation(internal.imports.batch, { orgId, batch: { records } }).then(() => "imported", (e: any) => e.data?.message);
    const { fieldId } = await client.mutation(api.fields.create, { orgId, objectId: company.object._id, key: "archivedRequired", label: "Archived", type: "text", required: true });
    await client.mutation(api.fields.retire, { orgId, fieldId });
    const owner = () => t.run(async (ctx: any) => (await ctx.db.query("members").collect()).find((m: any) => m.orgId === orgId && m.role === "owner"));
    const { _id } = await owner();
    await t.run((ctx: any) => ctx.db.patch(_id, { readScopes: [{ objectId: company.object._id, records: [], fields: "all" }] }));
    expect(await dry()).toBe("c (company): Record scope does not authorize new records");
    expect(await real()).toBe(await dry());
    await t.run((ctx: any) => ctx.db.patch(_id, { readScopes: undefined }));
    expect(await dry()).toBe("ready");
    expect(await real()).toBe("imported");
  });
});
