import { describe, expect, it } from "vitest";
import { api, objectFields, userAndOrg } from "./test.helpers";

describe("CSV import", () => {
  it("turns spreadsheet text into typed values, links by name, and reports bad rows by row number", async () => {
    const { client, orgId } = await userAndOrg();
    const company = await objectFields(client, orgId, "company"); const deal = await objectFields(client, orgId, "opportunity");
    await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: "Acme" } });
    const f = deal.fields;
    const result = await client.mutation(api.csv.importRows, {
      orgId, objectId: deal.object._id, firstRow: 2, skipDuplicates: true, createMissing: true,
      columns: [f.name._id, f.amount._id, f.stage._id, f.closeDate._id, f.company._id, null],
      rows: [
        ["Website", "$1,200", "Proposal", "9/22/2026", "acme", "ignored"],
        ["Logo", "300", "won", "2026-10-01", "Brand New Co", ""],
        ["Broken", "lots", "", "", "", ""],
        ["Website", "5", "", "", "", ""],
      ],
    });
    expect(result).toEqual({ created: 2, skipped: 1, errors: [{ row: 4, message: 'Amount: "lots" is not a number' }] });
    const rows = (await client.query(api.records.list, { orgId, objectId: deal.object._id, paginationOpts: { numItems: 10, cursor: null } })).page;
    const website = rows.find((r: any) => r.title === "Website");
    expect(website.values).toMatchObject({ [f.amount._id]: 1200, [f.stage._id]: "proposal", [f.closeDate._id]: Date.UTC(2026, 8, 22) });
    const companies = (await client.query(api.records.list, { orgId, objectId: company.object._id, paginationOpts: { numItems: 10, cursor: null } })).page.map((r: any) => r.title).sort();
    expect(companies).toEqual(["Acme", "Brand New Co"]);
  });

  it("refuses a missing link when asked not to create records", async () => {
    const { client, orgId } = await userAndOrg();
    const person = await objectFields(client, orgId, "person");
    const result = await client.mutation(api.csv.importRows, { orgId, objectId: person.object._id, firstRow: 2, skipDuplicates: false, createMissing: false, columns: [person.fields.name._id, person.fields.company._id], rows: [["Ada", "Nowhere Ltd"]] });
    expect(result.errors).toEqual([{ row: 2, message: 'Company: no Company named "Nowhere Ltd"' }]);
    expect(result.created).toBe(0);
  });
});

describe("CSV export", () => {
  it("writes readable values that the import reads back", async () => {
    const { client, orgId } = await userAndOrg();
    const company = await objectFields(client, orgId, "company"); const deal = await objectFields(client, orgId, "opportunity");
    const acme = await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: "Acme" } });
    await client.mutation(api.records.create, { orgId, objectId: deal.object._id, values: { [deal.fields.name._id]: "Site", [deal.fields.stage._id]: "won", [deal.fields.closeDate._id]: Date.UTC(2026, 0, 5), [deal.fields.company._id]: acme.recordId } });
    const page = await client.query(api.csv.exportPage, { orgId, objectId: deal.object._id, cursor: null });
    expect(page.header).toEqual(["Code", "Name", "Amount", "Stage", "Close Date", "Company", "Person"]);
    expect(page.rows[0].slice(1)).toEqual(["Site", "", "Won", "2026-01-05", "Acme", ""]);
    expect(page.done).toBe(true);
  });
});
