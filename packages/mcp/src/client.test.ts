import { describe, expect, it } from "vitest";
import { RemoldClient, RemoldError } from "./client.js";

describe("RemoldClient", () => {
  it("posts proposals with bearer auth", async () => {
    let request: Request | undefined;
    const client = new RemoldClient({ url: "https://remold.convex.site", key: "rm_key", fetch: async (input, init) => { request = new Request(input, init); return Response.json({ suggestion: { id: "s" } }, { status: 201 }); } });
    await client.propose({ action: "update", record: "brisk-ember-oyster", values: { stage: "Won" }, reason: "qualified" });
    expect(request?.url).toBe("https://remold.convex.site/api/v1/suggestions");
    expect(request?.headers.get("authorization")).toBe("Bearer rm_key");
    expect(await request?.json()).toEqual({ action: "update", record: "brisk-ember-oyster", values: { stage: "Won" }, reason: "qualified" });
  });
  it("reads a campaign report, previews an email for one person and marks a reply", async () => {
    const requests: Request[] = [];
    const client = new RemoldClient({ url: "https://remold.convex.site/", key: "rm_key", fetch: async (input, init) => { requests.push(new Request(input, init)); return Response.json({}); } });
    await client.campaignReport("calm-river-fox");
    await client.emailPreview({ idOrRef: "bold-sun-owl", person: "ava ref" });
    await client.markReplied("send/1");
    expect(requests.map((r) => [r.method, r.url])).toEqual([["GET", "https://remold.convex.site/api/v1/campaigns/calm-river-fox/report"], ["GET", "https://remold.convex.site/api/v1/emails/bold-sun-owl/preview?person=ava+ref"], ["POST", "https://remold.convex.site/api/v1/sends/send%2F1/replied"]]);
  });
  it("throws REST errors with their code", async () => {
    const client = new RemoldClient({ url: "https://remold.convex.site", key: "rm_key", fetch: async () => Response.json({ error: { code: "FORBIDDEN", message: "No grant" } }, { status: 403 }) });
    await expect(client.change({ action: "delete", record: "x", reason: "x" })).rejects.toMatchObject<Partial<RemoldError>>({ code: "FORBIDDEN", message: "No grant" });
  });
  it("passes multi-field filters and a range to REST", async () => {
    let url: URL | undefined;
    const client = new RemoldClient({ url: "https://remold.convex.site", key: "rm_key", fetch: async (input) => { url = new URL(String(input)); return Response.json({ records: [] }); } });
    await client.listRecords({ object: "person", filters: [{ field: "company", value: "Atlas" }, { field: "city", value: "Boston" }], range: { field: "createdOn", from: "2026-01-01", to: "2026-01-31" } });
    expect(url?.pathname).toBe("/api/v1/records");
    expect(url?.searchParams.get("object")).toBe("person");
    expect(url?.searchParams.get("filter[company]")).toBe("Atlas");
    expect(url?.searchParams.get("filter[city]")).toBe("Boston");
    expect(url?.searchParams.get("range[createdOn]")).toBe("2026-01-01..2026-01-31");
    await client.listRecords({ object: "task", range: { field: "dueDate", from: "2026-02-01" } });
    expect(url?.searchParams.get("range[dueDate]")).toBe("2026-02-01..");
  });
  it("proposes shape changes and lists the agent's own proposals", async () => {
    const requests: Request[] = [];
    const client = new RemoldClient({ url: "https://remold.convex.site", key: "rm_key", fetch: async (input, init) => { requests.push(new Request(input, init)); return Response.json({}); } });
    await client.proposeShape({ kind: "addField", object: "opportunity", key: "budget", label: "Budget", type: "number", reason: "tracked" });
    await client.shapeProposals({ status: "applied" });
    expect([requests[0]?.method, requests[0]?.url]).toEqual(["POST", "https://remold.convex.site/api/v1/shape/proposals"]);
    expect(await requests[0]?.json()).toEqual({ kind: "addField", object: "opportunity", key: "budget", label: "Budget", type: "number", reason: "tracked" });
    expect([requests[1]?.method, requests[1]?.url]).toEqual(["GET", "https://remold.convex.site/api/v1/shape/proposals?status=applied"]);
  });
  it("lists bookings by page and time", async () => {
    let url: URL | undefined;
    const client = new RemoldClient({ url: "https://remold.convex.site", key: "rm_key", fetch: async (input) => { url = new URL(String(input)); return Response.json({ bookings: [] }); } });
    expect(await client.bookings({ page: "brisk-ember-oyster", from: "2026-11-01", to: "2026-11-30" })).toEqual({ bookings: [] });
    expect(url?.pathname).toBe("/api/v1/bookings");
    expect(Object.fromEntries(url!.searchParams)).toEqual({ page: "brisk-ember-oyster", from: "2026-11-01", to: "2026-11-30" });
  });
});
