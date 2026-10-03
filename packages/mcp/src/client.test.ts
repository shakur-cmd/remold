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
  it("still accepts the single filter and sends it as REST's filter[field]", async () => {
    let url: URL | undefined;
    const client = new RemoldClient({ url: "https://remold.convex.site", key: "rm_key", fetch: async (input) => { url = new URL(String(input)); return Response.json({ records: [] }); } });
    await client.listRecords({ object: "person", filter: { field: "company", value: "Atlas" }, sort: { field: "name", direction: "asc" } });
    expect([...url!.searchParams]).toEqual([["object", "person"], ["filter[company]", "Atlas"], ["sort", "name"], ["direction", "asc"]]);
    await client.listRecords({ object: "person", filter: { field: "company", value: "Atlas" }, filters: [{ field: "city", value: "Boston" }] });
    expect(url?.searchParams.getAll("filter[company]")).toEqual(["Atlas"]);
    expect(url?.searchParams.getAll("filter[city]")).toEqual(["Boston"]);
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
  it("lists saved views and runs one, passing the time zone", async () => {
    const urls: string[] = [];
    const client = new RemoldClient({ url: "https://remold.convex.site", key: "rm_key", fetch: async (input) => { urls.push(String(input)); return Response.json({}); } });
    await client.views({ object: "opportunity" });
    await client.viewRecords({ id: "view/1", tz: "America/New_York", cursor: "c", limit: 10 });
    expect(urls).toEqual(["https://remold.convex.site/api/v1/views?object=opportunity", "https://remold.convex.site/api/v1/views/view%2F1/records?tz=America%2FNew_York&cursor=c&limit=10"]);
  });
  it("sends stable write keys as headers, excluding them from JSON", async () => {
   const requests: Request[] = [];
   const client = new RemoldClient({ url: "http://local", key: "test", fetch: async (input, init) => { requests.push(new Request(input, init)); return Response.json({ id: "original" }); } });
   for (const write of [client.change.bind(client), client.propose.bind(client), client.inboxAdd.bind(client), client.proposeShape.bind(client)]) {
     expect(await write({ reason: "test", idempotencyKey: "stable" })).toEqual({ id: "original" });
     expect(await write({ reason: "test", idempotencyKey: "stable" })).toEqual({ id: "original" });
   }
   for (const request of requests) { expect(request.headers.get("Idempotency-Key")).toBe("stable"); expect(await request.json()).toEqual({ reason: "test" }); }
 });
 it("pages record events with encoded ids and cursors", async () => {
   let request: Request | undefined;
   const client = new RemoldClient({ url: "http://local", key: "test", fetch: async (input, init) => { request = new Request(input, init); return Response.json({ events: [], nextCursor: "next" }); } });
   expect(await client.recordEvents({ idOrRef: "record/one", cursor: "range:1:2", limit: 3 })).toEqual({ events: [], nextCursor: "next" });
   expect(request?.url).toBe("http://local/api/v1/records/record%2Fone/events?cursor=range%3A1%3A2&limit=3");
 });

});
