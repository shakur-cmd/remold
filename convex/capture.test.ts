import { describe, expect, it } from "vitest";
import { api, objectFields, userAndOrg } from "./test.helpers";

describe("saving from the browser extension", () => {
  it("creates a person linked to an existing company by name, with a note about them", async () => {
    const { client, orgId } = await userAndOrg();
    const company = await objectFields(client, orgId, "company"); const person = await objectFields(client, orgId, "person"); const note = await objectFields(client, orgId, "note");
    const acme = await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: "Acme" } });
    const saved = await client.mutation(api.capture.save, { orgId, kind: "person", name: "Ada Lovelace", title: "Founder", company: "acme", linkedin: "https://www.linkedin.com/in/ada", note: "Met at the expo" });
    expect(saved).toMatchObject({ objectKey: "person", companyCreated: false });
    const got = (await client.query(api.records.get, { orgId, recordId: saved.recordId }))!;
    expect(got.record.values).toMatchObject({ [person.fields.title._id]: "Founder", [person.fields.company._id]: acme.recordId, [person.fields.linkedin._id]: "https://www.linkedin.com/in/ada" });
    const notes = await client.query(api.records.related, { orgId, recordId: saved.recordId, fieldId: note.fields.about._id, paginationOpts: { numItems: 5, cursor: null } });
    expect(notes.page.map((r: any) => r.title)).toEqual(["Met at the expo"]);
  });

  it("creates the company when it is new, and saves a plain company from a website", async () => {
    const { client, orgId } = await userAndOrg();
    const first = await client.mutation(api.capture.save, { orgId, kind: "person", name: "Ben", company: "Brand New Co" });
    expect(first.companyCreated).toBe(true);
    const site = await client.mutation(api.capture.save, { orgId, kind: "company", name: "Brand New Co", domain: "brandnew.co" });
    expect(site).toMatchObject({ companyCreated: false, objectKey: "company" });
  });

  it("refuses a caller who is not in the organisation", async () => {
    const { t, orgId } = await userAndOrg("A");
    const stranger = t.withIdentity({ tokenIdentifier: "clerk|B", name: "B" });
    await stranger.mutation(api.users.store, {});
    await expect(stranger.mutation(api.capture.save, { orgId, kind: "person", name: "Sneaky" })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  });
});
