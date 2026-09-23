import { describe, expect, it } from "vitest";
import { agentFor, api, userAndOrg } from "./test.helpers";

describe("agents", () => {
  it("creates a one-time key, hides its hash, replaces grants, and revokes it", async () => {
    const { client, orgId, t } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "claude-mac" });
    expect(agent.key).toMatch(/^rm_[0-9a-f]{40}$/);
    const listed = await client.query(api.agents.list, { orgId });
    expect(listed[0]).toMatchObject({ _id: agent.agentId, keyPrefix: agent.key.slice(0, 12) });
    expect(listed[0]).not.toHaveProperty("keyHash");
    await client.mutation(api.agents.setGrants, { orgId, agentId: agent.agentId, grants: [{ action: "update", objectKey: "company" }] });
    expect((await client.query(api.agents.list, { orgId }))[0]?.grants).toEqual([{ action: "update", objectKey: "company" }]);
    await client.mutation(api.agents.revoke, { orgId, agentId: agent.agentId });
    const response = await t.fetch("/api/v1/me", { headers: { authorization: `Bearer ${agent.key}` } });
    expect(response.status).toBe(401);
  });
  it("does not let a member create an agent", async () => {
    const { t, orgId } = await userAndOrg();
    const member = t.withIdentity({ tokenIdentifier: "clerk|member", name: "Member" });
    await member.mutation(api.users.store, {});
    const user = await member.query(api.users.me, {});
    await t.run((ctx) => ctx.db.insert("members", { orgId, userId: user!._id, role: "member" }));
    await expect(agentFor(member, orgId, { name: "nope" })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  });
});
