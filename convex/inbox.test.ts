import { describe, expect, it } from "vitest";
import { agentFor, api, rest, userAndOrg } from "./test.helpers";

describe("agent inbox", () => {
  it("queues user work oldest first and lets the agent resolve it once", async () => {
    const { client, orgId, t } = await userAndOrg();
    const first = await client.mutation(api.inbox.add, { orgId, shareWithAgents: true, text: "First" });
    await client.mutation(api.inbox.add, { orgId, shareWithAgents: true, text: "Second" });
    const agent = await agentFor(client, orgId, { name: "Claude" }), call = rest(t, agent.key);
    await client.mutation(api.agents.setSharedInbox, { orgId, agentId: agent.agentId, enabled: true });
    expect((await call("GET", "/api/v1/inbox")).json.map((item: any) => item.text)).toEqual(["First", "Second"]);
    expect((await call("POST", `/api/v1/inbox/${first}/resolve`, { note: "done" })).status).toBe(200);
    expect((await call("GET", "/api/v1/inbox")).json.map((item: any) => item.text)).toEqual(["Second"]);
    expect((await call("POST", `/api/v1/inbox/${first}/resolve`)).status).toBe(409);
  });
});
