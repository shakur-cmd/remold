import { afterEach, expect, it, vi } from "vitest";
import { agentFor, api, rest, userAndOrg } from "./test.helpers";

afterEach(() => vi.restoreAllMocks());

it("limits writes per key without starving reads or other agents", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  const { t, client, orgId } = await userAndOrg();
  const a = await agentFor(client, orgId, { name: "first" });
  const second = await agentFor(client, orgId, { name: "second" });
  const call = rest(t, a.key);
  for (let i = 0; i < 120; i++) expect((await call("POST", "/api/v1/inbox", { text: "allowed" })).status).toBe(201);
  expect((await call("GET", "/api/v1/me")).status).toBe(200);
  expect((await rest(t, second.key)("POST", "/api/v1/inbox", { text: "teammate" })).status).toBe(201);
  const before = await t.run(async (ctx) => ({ inbox: await ctx.db.query("agentInbox").collect(), events: await ctx.db.query("events").collect() }));
  const denied = await t.fetch("/api/v1/inbox", { method: "POST", headers: { authorization: `Bearer ${a.key}`, "content-type": "application/json" }, body: JSON.stringify({ text: "must not appear" }) });
  expect(denied.status).toBe(429);
  expect(denied.headers.get("retry-after")).toBe("1");
  expect(await denied.json()).toMatchObject({ error: { code: "RATE_LIMITED", retryAfter: 1 } });
  expect(await t.run(async (ctx) => ({ inbox: await ctx.db.query("agentInbox").collect(), events: await ctx.db.query("events").collect() }))).toEqual(before);
  const b = t.withIdentity({ tokenIdentifier: "clerk|B", name: "B" });
  await b.mutation(api.users.store, {});
  const orgB = await b.mutation(api.orgs.create, { name: "B" });
  const agentB = await agentFor(b, orgB, { name: "B" });
  expect((await rest(t, agentB.key)("GET", "/api/v1/me")).status).toBe(200);
});

it("refills the key allowance over time and still rejects a revoked key", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  const { t, client, orgId } = await userAndOrg();
  const agent = await agentFor(client, orgId, { name: "agent" });
  const call = rest(t, agent.key);
  for (let i = 0; i < 120; i++) await call("POST", "/api/v1/inbox", { text: "allowed" });
  expect((await call("POST", "/api/v1/inbox", { text: "allowed" })).status).toBe(429);
  clock.mockReturnValue(1_800_000_000_500);
  expect((await call("POST", "/api/v1/inbox", { text: "one token refilled" })).status).toBe(201);
  expect((await call("POST", "/api/v1/inbox", { text: "allowed" })).status).toBe(429);
  await client.mutation(api.agents.revoke, { orgId, agentId: agent.agentId });
  expect((await call("POST", "/api/v1/inbox", { text: "revoked" })).status).toBe(401);
});
