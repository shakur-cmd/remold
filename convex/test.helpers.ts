import { api } from "./_generated/api";
import { makeTest } from "./test.setup";
import { applyChange } from "./lib/applyChange";
import { callTool } from "../packages/mcp/src/tools";
import { httpSend } from "../packages/mcp/src/client";

export async function userAndOrg(name = "A") {
  const t = makeTest();
  const identity = { tokenIdentifier: `clerk|${name}`, name };
  const client = t.withIdentity(identity);
  await client.mutation(api.users.store, {});
  const orgId = await client.mutation(api.orgs.create, { name: `${name} Org` });
  const objects = await client.query(api.objects.list, { orgId });
  return { t, client, orgId, objects };
}

export async function objectFields(client: any, orgId: any, key: string) {
  const objects = await client.query(api.objects.list, { orgId });
  const object = objects.find((item: any) => item.key === key);
  const detail = await client.query(api.objects.get, { orgId, objectId: object._id });
  return { object, fields: Object.fromEntries(detail.fields.map((field: any) => [field.key, field])) };
}

export async function agentFor(client: any, orgId: any, options: { name: string; role?: "admin" | "member"; grants?: { action: "create" | "update" | "delete"; objectKey: string }[] }) {
  return client.action(api.agents.create, { orgId, ...options });
}

export function rest(t: any, key: string) {
  return async (method: string, path: string, body?: unknown) => {
    const response = await t.fetch(path, { method, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() };
  };
}

// Hundreds of writes through applyChange in one transaction, for paging fixtures:
// the same write path and events as the app, without one round trip per row.
export async function bulk(t: any, orgId: any, write: (apply: (change: any) => Promise<any>) => Promise<void>) {
  await t.run(async (ctx: any) => {
    const member = (await ctx.db.query("members").collect()).find((m: any) => m.orgId === orgId);
    const membership = { user: await ctx.db.get(member.userId), actor: { kind: "user" as const, id: member.userId }, member, org: await ctx.db.get(orgId) };
    await write((change) => applyChange(ctx, membership, { orgId, ...change }));
  });
}

// fetch for code that calls the deployment by URL: routes it to this test's HTTP router.
export const via = (t: any) => (url: string | URL | Request, init?: RequestInit) => { const u = new URL(url instanceof Request ? url.url : String(url)); return t.fetch(u.pathname + u.search, init); };

// The MCP tools as the stdio server runs them, over this test's REST routes. Tool errors throw "CODE: message".
export function mcpTool(t: any, key: string, fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = via(t)) {
  return async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const result = await callTool(name, args, httpSend({ url: "https://remold.test", key, fetch: fetch as typeof globalThis.fetch }));
    if (!result) throw new Error(`Unknown tool: ${name}`);
    if (result.isError) throw new Error(result.content[0]!.text);
    return JSON.parse(result.content[0]!.text);
  };
}

export { api };
