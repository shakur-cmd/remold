import { describe, expect, it } from "vitest";
import { httpSend } from "./client.js";
import { callTool, conform, toolList } from "./tools.js";

// Each tool call becomes one REST request; these record what the stdio server sends.
function recorder(reply: (request: Request) => Response = () => Response.json({})) {
  const requests: Request[] = [];
  const send = httpSend({ url: "https://remold.convex.site/", key: "rm_key", fetch: async (input, init) => { const request = new Request(input, init); requests.push(request); return reply(request.clone()); } });
  return { requests, call: (name: string, args: Record<string, unknown>) => callTool(name, args, send) };
}

describe("stdio tool calls", () => {
  it("posts proposals with bearer auth", async () => {
    const { requests, call } = recorder(() => Response.json({ suggestion: { id: "s" } }, { status: 201 }));
    expect(await call("remold_propose_change", { action: "update", record: "brisk-ember-oyster", values: { stage: "Won" }, reason: "qualified" })).toEqual({ content: [{ type: "text", text: JSON.stringify({ suggestion: { id: "s" } }, null, 2) }] });
    expect(requests[0]?.url).toBe("https://remold.convex.site/api/v1/suggestions");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer rm_key");
    expect(await requests[0]?.json()).toEqual({ action: "update", record: "brisk-ember-oyster", values: { stage: "Won" }, reason: "qualified" });
  });
  it("reads a campaign report, previews an email for one person and marks a reply", async () => {
    const { requests, call } = recorder();
    await call("remold_campaign_report", { idOrRef: "calm-river-fox" });
    await call("remold_email_preview", { idOrRef: "bold-sun-owl", person: "ava ref" });
    await call("remold_mark_replied", { sendId: "send/1" });
    expect(requests.map((r) => [r.method, r.url])).toEqual([["GET", "https://remold.convex.site/api/v1/campaigns/calm-river-fox/report"], ["GET", "https://remold.convex.site/api/v1/emails/bold-sun-owl/preview?person=ava+ref"], ["POST", "https://remold.convex.site/api/v1/sends/send%2F1/replied"]]);
  });
  it("returns REST errors as tool errors with their code, and a failed connection as INTERNAL", async () => {
    expect(await recorder(() => Response.json({ error: { code: "FORBIDDEN", message: "No grant" } }, { status: 403 })).call("remold_apply_change", { action: "delete", record: "x", reason: "x" })).toEqual({ isError: true, content: [{ type: "text", text: "FORBIDDEN: No grant" }] });
    expect(await recorder(() => { throw new Error("connection refused"); }).call("remold_me", {})).toEqual({ isError: true, content: [{ type: "text", text: "INTERNAL: Something went wrong" }] });
  });
  it("passes multi-field filters and a range to REST", async () => {
    const { requests, call } = recorder();
    await call("remold_list_records", { object: "person", filters: [{ field: "company", value: "Atlas" }, { field: "city", value: "Boston" }], range: { field: "createdOn", from: "2026-01-01", to: "2026-01-31" } });
    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe("/api/v1/records");
    expect(url.searchParams.get("object")).toBe("person");
    expect(url.searchParams.get("filter[company]")).toBe("Atlas");
    expect(url.searchParams.get("filter[city]")).toBe("Boston");
    expect(url.searchParams.get("range[createdOn]")).toBe("2026-01-01..2026-01-31");
    await call("remold_list_records", { object: "task", range: { field: "dueDate", from: "2026-02-01" } });
    expect(new URL(requests[1]!.url).searchParams.get("range[dueDate]")).toBe("2026-02-01..");
  });
  it("still accepts the single filter and sends it as REST's filter[field]", async () => {
    const { requests, call } = recorder();
    await call("remold_list_records", { object: "person", filter: { field: "company", value: "Atlas" }, sort: { field: "name", direction: "asc" } });
    expect([...new URL(requests[0]!.url).searchParams]).toEqual([["object", "person"], ["filter[company]", "Atlas"], ["sort", "name"], ["direction", "asc"]]);
    await call("remold_list_records", { object: "person", filter: { field: "company", value: "Atlas" }, filters: [{ field: "city", value: "Boston" }] });
    expect(new URL(requests[1]!.url).searchParams.getAll("filter[company]")).toEqual(["Atlas"]);
    expect(new URL(requests[1]!.url).searchParams.getAll("filter[city]")).toEqual(["Boston"]);
  });
  it("proposes shape changes and lists the agent's own proposals", async () => {
    const { requests, call } = recorder();
    await call("remold_propose_shape", { kind: "addField", object: "opportunity", key: "budget", label: "Budget", type: "number", reason: "tracked" });
    await call("remold_shape_proposals", { status: "applied" });
    expect([requests[0]?.method, requests[0]?.url]).toEqual(["POST", "https://remold.convex.site/api/v1/shape/proposals"]);
    expect(await requests[0]?.json()).toEqual({ kind: "addField", object: "opportunity", key: "budget", label: "Budget", type: "number", reason: "tracked" });
    expect([requests[1]?.method, requests[1]?.url]).toEqual(["GET", "https://remold.convex.site/api/v1/shape/proposals?status=applied"]);
  });
  it("lists saved views and runs one, passing the time zone", async () => {
    const { requests, call } = recorder();
    await call("remold_views", { object: "opportunity" });
    await call("remold_view_records", { id: "view/1", tz: "America/New_York", cursor: "c", limit: 10 });
    expect(requests.map((r) => r.url)).toEqual(["https://remold.convex.site/api/v1/views?object=opportunity", "https://remold.convex.site/api/v1/views/view%2F1/records?tz=America%2FNew_York&cursor=c&limit=10"]);
  });
  it("sends stable write keys as headers, excluding them from JSON", async () => {
    const { requests, call } = recorder(() => Response.json({ id: "original" }));
    const writes: [string, Record<string, unknown>][] = [["remold_apply_change", { action: "create", object: "task", reason: "test" }], ["remold_propose_change", { action: "create", object: "task", reason: "test" }], ["remold_inbox_add", { text: "test" }], ["remold_propose_shape", { kind: "relabel", reason: "test" }], ["remold_inbox_resolve", { id: "i" }], ["remold_mark_replied", { sendId: "s" }]];
    for (const [name, args] of writes) for (let i = 0; i < 2; i++) expect((await call(name, { ...args, idempotencyKey: "stable" }))?.isError).toBeUndefined();
    expect(requests).toHaveLength(12);
    for (const request of requests) { expect(request.headers.get("Idempotency-Key")).toBe("stable"); expect(await request.json()).not.toHaveProperty("idempotencyKey"); }
  });
  it("pages record events with encoded ids and cursors", async () => {
    const { requests, call } = recorder(() => Response.json({ events: [], nextCursor: "next" }));
    expect((await call("remold_record_events", { idOrRef: "record/one", cursor: "range:1:2", limit: 3 }))?.content[0]?.text).toBe(JSON.stringify({ events: [], nextCursor: "next" }, null, 2));
    expect(requests[0]?.url).toBe("https://remold.convex.site/api/v1/records/record%2Fone/events?cursor=range%3A1%3A2&limit=3");
  });
});

describe("tool argument checks", () => {
  it("refuses arguments that break the schema before sending anything, and drops unknown keys", async () => {
    const { requests, call } = recorder();
    expect(await call("remold_get_record", { idOrRef: 5 })).toEqual({ isError: true, content: [{ type: "text", text: "VALIDATION: Invalid arguments for remold_get_record: idOrRef must be a string" }] });
    expect((await call("remold_list_records", { object: "x", limit: 1.5 }))?.content[0]?.text).toMatch(/limit must be a whole number/);
    expect((await call("remold_propose_shape", { kind: "addView", reason: "x", filters: [1, 2, 3, 4] }))?.content[0]?.text).toMatch(/filters takes at most 3/);
    expect((await call("remold_propose_change", { action: "explode", reason: "x" }))?.content[0]?.text).toMatch(/action must be one of create, update, delete/);
    expect((await call("remold_list_records", { object: "x", sort: { field: "a" } }))?.content[0]?.text).toMatch(/sort.direction is required/);
    expect(requests).toHaveLength(0);
    await call("remold_inbox_add", { text: "hi", keyHash: "forged", __proto__: { polluted: true } });
    expect(await requests[0]?.json()).toEqual({ text: "hi" });
  });
  it("keeps every key of a free-form values object, including __proto__, as plain data", () => {
    const values = JSON.parse('{"name":"A","__proto__":{"x":1}}');
    const checked = conform(toolList.find((t) => t.name === "remold_propose_change")!.inputSchema, { action: "create", reason: "r", values }) as { value: any };
    expect(Object.keys(checked.value.values)).toEqual(["name", "__proto__"]);
    expect(({} as any).x).toBeUndefined();
  });
  it("reports an unknown tool as missing rather than as a tool result", async () => {
    expect(await recorder().call("remold_nope", {})).toBeUndefined();
  });
});
