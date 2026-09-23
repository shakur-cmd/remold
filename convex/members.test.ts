import { describe, expect, it } from "vitest";
import { api, userAndOrg } from "./test.helpers";
import { makeTest } from "./test.setup";

const forbidden = { data: { code: "FORBIDDEN" } };

async function join(t: any, orgId: any, owner: any, name: string, role: "admin" | "member" = "member") {
  const invite = await owner.mutation(api.invites.create, { orgId, role });
  const client = t.withIdentity({ tokenIdentifier: `clerk|${name}`, name });
  await client.mutation(api.users.store, {});
  await client.mutation(api.invites.accept, { token: invite.token });
  const user = await client.query(api.users.me, {});
  return { client, userId: user!._id };
}

describe("people in an org", () => {
  it("shows the name the app sends when the sign-in token carries none", async () => {
    const t = makeTest();
    const client = t.withIdentity({ tokenIdentifier: "clerk|bare" });
    await client.mutation(api.users.store, { profile: { name: "Shakur Abdullah", email: "shakur@example.invalid" } });
    const me = await client.query(api.users.me, {});
    expect(me!.name).toBe("Shakur Abdullah");
    expect(me!.email).toBe("shakur@example.invalid");
    await client.mutation(api.users.store, {});
    expect((await client.query(api.users.me, {}))!.name).toBe("Shakur Abdullah");
  });

  it("lets an owner change roles and remove people, and a removed person loses access", async () => {
    const { t, client: owner, orgId } = await userAndOrg("owner");
    const b = await join(t, orgId, owner, "b");
    await owner.mutation(api.orgs.setRole, { orgId, userId: b.userId, role: "admin" });
    expect((await b.client.query(api.orgs.members, { orgId })).find((m: any) => m.user._id === b.userId)!.member.role).toBe("admin");
    await owner.mutation(api.orgs.removeMember, { orgId, userId: b.userId });
    await expect(b.client.query(api.orgs.get, { orgId })).rejects.toMatchObject(forbidden);
    expect(await b.client.query(api.orgs.mine, {})).toEqual([]);
  });

  it("keeps a member from managing others and keeps the last owner in place", async () => {
    const { t, client: owner, orgId } = await userAndOrg("owner");
    const ownerId = (await owner.query(api.users.me, {}))!._id;
    const b = await join(t, orgId, owner, "b");
    const c = await join(t, orgId, owner, "c");
    await expect(b.client.mutation(api.orgs.setRole, { orgId, userId: c.userId, role: "admin" })).rejects.toMatchObject(forbidden);
    await expect(b.client.mutation(api.orgs.removeMember, { orgId, userId: c.userId })).rejects.toMatchObject(forbidden);
    await expect(owner.mutation(api.orgs.setRole, { orgId, userId: ownerId, role: "member" })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
    await expect(owner.mutation(api.orgs.leave, { orgId })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
    await b.client.mutation(api.orgs.leave, { orgId });
    expect(await b.client.query(api.orgs.mine, {})).toEqual([]);
    expect((await owner.query(api.orgs.members, { orgId })).length).toBe(2);
  });
});
