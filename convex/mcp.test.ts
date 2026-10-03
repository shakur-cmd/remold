import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { internal } from "./_generated/api";
import { agentFor, api, objectFields, rest, userAndOrg, via } from "./test.helpers";
import { stdioServer } from "../packages/mcp/src/server";
import { httpSend } from "../packages/mcp/src/client";

// The hosted endpoint is the same MCP server as packages/mcp, served from the Convex site at /mcp.
const hex = async (key: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const rpc = (t: any, key?: string, headers: Record<string, string> = {}) => async (body: unknown, raw = false) => {
  const response = await t.fetch("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, body: raw ? body as string : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : undefined, headers: response.headers };
};
const call = (name: string, args: unknown, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
async function hosted(t: any, key: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("https://remold.test/mcp"), { fetch: via(t), requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return client;
}
async function local(t: any, key: string) {
  const [server, client] = InMemoryTransport.createLinkedPair(), mcp = new Client({ name: "test", version: "0" });
  await stdioServer(httpSend({ url: "https://remold.test", key, fetch: via(t) as typeof fetch })).connect(server);
  await mcp.connect(client);
  return mcp;
}
const suggestionCount = (t: any) => t.run(async (ctx: any) => (await ctx.db.query("suggestions").collect()).length);
async function venue(client: any, orgId: any) {
  const objectId = await client.mutation(api.objects.create, { orgId, key: "venue", label: "Venue", labelPlural: "Venues" });
  await client.mutation(api.fields.create, { orgId, objectId, key: "capacity", label: "Capacity", type: "number" });
  const { fields } = await objectFields(client, orgId, "venue");
  return { objectId, fields, recordId: (await client.mutation(api.records.create, { orgId, objectId, values: { [fields.name._id]: "Hall", [fields.capacity._id]: 200 } })).recordId };
}

describe("hosted MCP endpoint", () => {
  it("a real MCP client initializes, lists every tool and calls one over Streamable HTTP", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "remote" }), mcp = await hosted(t, agent.key);
    expect(mcp.getServerVersion()).toEqual({ name: "remold", version: "0.0.0" });
    expect(mcp.getInstructions()).toMatch(/^Remold is the team's CRM/);
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toContain("remold_propose_change");
    const me = await mcp.callTool({ name: "remold_me", arguments: {} });
    expect(me.isError).toBeFalsy();
    expect(JSON.parse((me.content as any)[0].text)).toMatchObject({ agent: { name: "remote" } });
    await mcp.close();
  });

  it("answers initialize, the initialized notification and ping per the stateless JSON mode", async () => {
    const { t, client, orgId } = await userAndOrg();
    const send = rpc(t, (await agentFor(client, orgId, { name: "raw" })).key);
    const init = await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } } });
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toMatch(/^application\/json/);
    expect(init.headers.get("mcp-session-id")).toBeNull();
    expect(init.json).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "remold" } } });
    expect((await send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "raw", version: "0" } } })).json.result.protocolVersion).toBe("2025-11-25");
    const initialized = await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect([initialized.status, initialized.text]).toEqual([202, ""]);
    expect((await send({ jsonrpc: "2.0", id: "p", method: "ping" })).json).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
    for (const method of ["GET", "DELETE"]) {
      const response = await t.fetch("/mcp", { method, headers: { authorization: "Bearer x" } });
      expect([response.status, response.headers.get("allow")]).toEqual([405, "POST"]);
    }
  });

  it("refuses a missing, malformed, unknown or revoked key with 401 and a JSON-RPC error, and writes nothing", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "gone" });
    await client.mutation(api.agents.revoke, { orgId, agentId: agent.agentId });
    const propose = call("remold_propose_change", { action: "create", object: "company", values: { name: "Sneaky" }, reason: "x" });
    for (const key of [undefined, "not-a-key", `rm_${"0".repeat(40)}`, agent.key]) {
      for (const body of [propose, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { jsonrpc: "2.0", method: "notifications/initialized" }]) {
        const response = await rpc(t, key)(body);
        expect(response.status).toBe(401);
        expect(response.json).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32001 } });
        expect(response.headers.get("www-authenticate")).toBe("Bearer");
      }
    }
    expect(await suggestionCount(t)).toBe(0);
  });

  it("answers malformed JSON-RPC, unknown methods and unknown tools with JSON-RPC errors, and checks arguments before calling anything", async () => {
    const { t, client, orgId } = await userAndOrg();
    const send = rpc(t, (await agentFor(client, orgId, { name: "sloppy" })).key);
    expect(await send("{not json", true)).toMatchObject({ status: 400, json: { jsonrpc: "2.0", id: null, error: { code: -32700 } } });
    expect(await send([{ jsonrpc: "2.0", id: 1, method: "ping" }])).toMatchObject({ status: 400, json: { id: null, error: { code: -32600 } } });
    expect(await send({ id: 1, method: "ping" })).toMatchObject({ status: 400, json: { id: null, error: { code: -32600 } } });
    expect(await send({ jsonrpc: "2.0", id: { x: 1 }, method: "ping" })).toMatchObject({ status: 400, json: { id: null, error: { code: -32600 } } });
    expect(await send({ jsonrpc: "2.0", id: 3, method: "resources/list" })).toMatchObject({ status: 200, json: { id: 3, error: { code: -32601 } } });
    expect(await send(call("remold_drop_tables", {}, 4))).toMatchObject({ status: 200, json: { id: 4, error: { code: -32602, message: "Unknown tool: remold_drop_tables" } } });
    expect(await send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { arguments: {} } })).toMatchObject({ json: { id: 5, error: { code: -32602 } } });
    const bad = await send(call("remold_propose_change", { action: "explode", values: "nope", reason: 7 }, 6));
    expect(bad.json.result.isError).toBe(true);
    expect(bad.json.result.content[0].text).toMatch(/^VALIDATION: /);
    expect(await suggestionCount(t)).toBe(0);
    expect((await rpc(t, (await agentFor(client, orgId, { name: "web" })).key, { origin: "https://evil.example" })({ jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(403);
    expect((await rpc(t, (await agentFor(client, orgId, { name: "future" })).key, { "mcp-protocol-version": "2031-01-01" })({ jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(400);
  });

  it("gives a scoped agent exactly its REST permissions: reads, proposals, refused applies and hidden fields", async () => {
    const { t, client, orgId } = await userAndOrg();
    const early = await agentFor(client, orgId, { name: "early" }), v = await venue(client, orgId);
    const masked = await agentFor(client, orgId, { name: "masked" });
    await client.mutation(api.agents.setReadAccess, { orgId, agentId: masked.agentId, readAllObjects: true, objectIds: [] });
    await client.mutation(api.authority.policies.setAgentMasks, { orgId, agentId: masked.agentId, hiddenFieldIds: [v.fields.capacity._id] });
    const company = await objectFields(client, orgId, "company");
    const atlas = (await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: "Atlas" } })).recordId;
    const same = async (key: string, tool: string, args: Record<string, unknown>, method: string, path: string, body?: unknown) => {
      const viaRest = await rest(t, key)(method, path, body), viaMcp = (await rpc(t, key)(call(tool, args))).json.result;
      expect(viaMcp.content[0].text).toBe(viaRest.status < 400 ? JSON.stringify(viaRest.json, null, 2) : `${viaRest.json.error.code}: ${viaRest.json.error.message}`);
      expect(!!viaMcp.isError).toBe(viaRest.status >= 400);
      return { viaRest, viaMcp: JSON.parse(viaMcp.isError ? "null" : viaMcp.content[0].text) };
    };
    expect((await same(early.key, "remold_list_records", { object: "company" }, "GET", "/api/v1/records?object=company")).viaMcp.records.map((r: any) => r.title)).toEqual(["Atlas"]);
    expect((await same(early.key, "remold_list_records", { object: "venue" }, "GET", "/api/v1/records?object=venue")).viaRest.status).toBe(404);
    expect((await same(masked.key, "remold_get_record", { idOrRef: v.recordId }, "GET", `/api/v1/records/${v.recordId}`)).viaMcp.record.values).toEqual({ name: "Hall" });
    const denied = await same(early.key, "remold_apply_change", { action: "update", record: atlas, values: { city: "Boston" }, reason: "x" }, "POST", "/api/v1/changes", { action: "update", record: atlas, values: { city: "Boston" }, reason: "x" });
    expect(denied.viaRest.json.error.code).toBe("FORBIDDEN");
    expect((await client.query(api.records.get, { orgId, recordId: atlas }))!.record.values[company.fields.city._id]).toBeUndefined();
    const proposed = await rpc(t, early.key)(call("remold_propose_change", { action: "update", record: atlas, values: { city: "Boston" }, reason: "moved" }));
    expect(JSON.parse(proposed.json.result.content[0].text).suggestion).toMatchObject({ status: "pending", values: { city: "Boston" } });
    expect((await client.query(api.records.get, { orgId, recordId: atlas }))!.record.values[company.fields.city._id]).toBeUndefined();
  });

  it("shares the REST write rate limit with the agent's key", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "busy" }), keyHash = await hex(agent.key);
    for (let i = 0; i < 120; i++) await t.mutation(internal.rateLimit.take, { keyHash });
    const limited = (await rpc(t, agent.key)(call("remold_inbox_add", { text: "one more" }))).json.result;
    expect(limited).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^RATE_LIMITED: /) }] });
    expect(await t.run(async (ctx: any) => (await ctx.db.query("agentInbox").collect()).length)).toBe(0);
    expect((await rpc(t, agent.key)(call("remold_me", {}))).json.result.isError).toBeFalsy();
  });

  it("replays a write sent again with the same idempotency key and refuses the key for a different write", async () => {
    const { t, client, orgId } = await userAndOrg();
    const send = rpc(t, (await agentFor(client, orgId, { name: "retry" })).key);
    const args = { idempotencyKey: "op-1", action: "create", object: "company", values: { name: "Once" }, reason: "x" };
    const first = (await send(call("remold_propose_change", args))).json.result, second = (await send(call("remold_propose_change", args))).json.result;
    expect(second.content[0].text).toBe(first.content[0].text);
    expect(await suggestionCount(t)).toBe(1);
    expect((await send(call("remold_propose_change", { ...args, reason: "different" }))).json.result.content[0].text).toMatch(/^IDEMPOTENCY_MISMATCH: /);
  });

  it("never puts the key or its hash in a response", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "secret" }), keyHash = await hex(agent.key), send = rpc(t, agent.key);
    // Bodies that get past the tool schema but not the Convex validators: Convex error text would echo every argument.
    const bodies = [call("remold_view_records", { id: "views|bad" }), call("remold_inbox_resolve", { id: "123", suggestionId: "zzz", recordId: "q" }), call("remold_propose_change", { action: "update", record: "nope", values: { name: { deep: [1] } }, reason: "x", inboxId: "bad" }), call("remold_apply_change", { action: "delete", record: "nope", reason: "x", keyHash: "rm_override" }), call("remold_list_records", { object: "company", sort: { field: "nope", direction: "asc" } }), call("remold_propose_shape", { kind: "addField", reason: "x", object: "company", key: "a", label: "A", type: "lookup", target: "nowhere" }), call("remold_list_records", { object: 1 })];
    for (const body of bodies) { const { text } = await send(body); expect(text).not.toContain(keyHash); expect(text).not.toContain(agent.key); }
    // Refused by the REST route's shape check before any Convex function runs, so nothing logs the arguments.
    expect((await send(bodies[1]!)).json.result.content[0].text).toBe("VALIDATION: Invalid request body for this route");
    expect((await send(bodies[2]!)).json.result.content[0].text).toBe("VALIDATION: Invalid request body for this route");
  });

  it("records each MCP request in the same operational telemetry as REST", async () => {
    const { t, client, orgId } = await userAndOrg();
    await rpc(t, (await agentFor(client, orgId, { name: "seen" })).key)({ jsonrpc: "2.0", id: 1, method: "ping" });
    await rpc(t)({ jsonrpc: "2.0", id: 1, method: "ping" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await t.finishInProgressScheduledFunctions();
    const rows: any[] = await t.run((ctx: any) => ctx.db.query("opsMetrics").collect());
    expect(rows.map((row: any) => [row.route, row.status]).sort()).toEqual([["rest", "200"], ["rest", "401"]]);
  });
});

describe("stdio and hosted MCP parity", () => {
  it("list the same tools and instructions and give the same results and errors", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "twin", grants: [{ action: "create", objectKey: "task" }] });
    const company = await objectFields(client, orgId, "company");
    const atlas = (await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: "Atlas" } })).recordId;
    const remote = await hosted(t, agent.key), stdio = await local(t, agent.key);
    expect((await remote.listTools()).tools).toEqual((await stdio.listTools()).tools);
    expect(remote.getInstructions()).toBe(stdio.getInstructions());
    expect(remote.getServerVersion()).toEqual(stdio.getServerVersion());
    expect(remote.getServerCapabilities()).toEqual(stdio.getServerCapabilities());
    const calls: [string, Record<string, unknown>][] = [["remold_me", {}], ["remold_objects", {}], ["remold_list_records", { object: "company", filters: [{ field: "name", value: "Atlas" }] }], ["remold_get_record", { idOrRef: atlas }], ["remold_search", { q: "Atl" }], ["remold_today", {}], ["remold_inbox", {}], ["remold_views", {}], ["remold_list_suggestions", {}], ["remold_shape_proposals", {}],
      ["remold_apply_change", { action: "update", record: atlas, values: { city: "Boston" }, reason: "no grant" }], ["remold_get_record", { idOrRef: "no-such-record" }], ["remold_list_records", { object: "company", limit: "ten" }], ["remold_record_events", { idOrRef: atlas, limit: 1.5 }], ["remold_campaign_report", { idOrRef: atlas }]];
    for (const [name, args] of calls) {
      const [a, b] = [await remote.callTool({ name, arguments: args }), await stdio.callTool({ name, arguments: args })];
      expect({ name, ...a }).toEqual({ name, ...b });
    }
    const unknown = await Promise.allSettled([remote.callTool({ name: "remold_nope", arguments: {} }), stdio.callTool({ name: "remold_nope", arguments: {} })]);
    expect(unknown.map((r) => r.status === "rejected" && String(r.reason))).toEqual(["McpError: MCP error -32602: Unknown tool: remold_nope", "McpError: MCP error -32602: Unknown tool: remold_nope"]);
    // Writes: the same create through each path makes one record each, attributed to the agent.
    for (const mcp of [remote, stdio]) expect((await mcp.callTool({ name: "remold_apply_change", arguments: { action: "create", object: "task", values: { title: "Call Atlas", dueDate: "2026-10-05" }, reason: "follow up" } })).isError).toBeFalsy();
    expect(await t.run(async (ctx: any) => (await ctx.db.query("records").collect()).filter((r: any) => r.createdBy === agent.agentId).length)).toBe(2);
    await remote.close(); await stdio.close();
  });
});
