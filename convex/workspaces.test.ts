import { afterEach, describe, expect, it, vi } from "vitest";
import { api, userAndOrg } from "./test.helpers";

const signIn = async (t: any, name: string, email?: string, emailVerified?: boolean) => {
  const client = t.withIdentity({ tokenIdentifier: `workos|${name}`, name, email, emailVerified });
  await client.mutation(api.users.store, {});
  return client;
};

describe("workspace creation", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("refuses a signed-in stranger and tells the app so", async () => {
    const { t } = await userAndOrg("owner");
    vi.stubEnv("REMOLD_OPEN_SIGNUP", "");
    vi.stubEnv("REMOLD_WORKSPACE_CREATORS", "shakur@codemyvibe.com");
    const stranger = await signIn(t, "stranger", "someone@gmail.com", true);
    await expect(stranger.mutation(api.orgs.create, { name: "Mine" })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    expect(await stranger.query(api.orgs.canCreate, {})).toBe(false);
    expect(await stranger.query(api.orgs.mine, {})).toEqual([]);
  });
  it("lets a listed creator in, ignoring case and spaces", async () => {
    const { t } = await userAndOrg("owner");
    vi.stubEnv("REMOLD_OPEN_SIGNUP", "");
    vi.stubEnv("REMOLD_WORKSPACE_CREATORS", " other@x.com , Shakur@CodeMyVibe.com");
    const owner = await signIn(t, "shakur", "shakur@codemyvibe.com", true);
    expect(await owner.query(api.orgs.canCreate, {})).toBe(true);
    const orgId = await owner.mutation(api.orgs.create, { name: "CodeMyVibe" });
    expect((await owner.query(api.orgs.get, { orgId })).name).toBe("CodeMyVibe");
  });
  it("trusts only an email the sign-in token marks verified, not an unmarked one or the profile the app sends", async () => {
    const { t } = await userAndOrg("owner");
    vi.stubEnv("REMOLD_OPEN_SIGNUP", "");
    vi.stubEnv("REMOLD_WORKSPACE_CREATORS", "shakur@codemyvibe.com");
    const unverified = await signIn(t, "unverified", "shakur@codemyvibe.com", false);
    await expect(unverified.mutation(api.orgs.create, { name: "X" })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    const unproven = await signIn(t, "unproven", "shakur@codemyvibe.com");
    expect(await unproven.query(api.orgs.canCreate, {})).toBe(false);
    await expect(unproven.mutation(api.orgs.create, { name: "X" })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    const spoof = t.withIdentity({ tokenIdentifier: "workos|spoof", name: "Spoof" });
    await spoof.mutation(api.users.store, { profile: { email: "shakur@codemyvibe.com" } });
    await expect(spoof.mutation(api.orgs.create, { name: "X" })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  });
  it("lets anyone create a workspace when open signup is on", async () => {
    const { t } = await userAndOrg("owner");
    vi.stubEnv("REMOLD_OPEN_SIGNUP", "1");
    vi.stubEnv("REMOLD_WORKSPACE_CREATORS", "");
    const stranger = await signIn(t, "stranger");
    expect(await stranger.query(api.orgs.canCreate, {})).toBe(true);
    await stranger.mutation(api.orgs.create, { name: "Open" });
  });
  it("still lets an invited stranger join an existing workspace", async () => {
    const { t, client: owner, orgId } = await userAndOrg("owner");
    vi.stubEnv("REMOLD_OPEN_SIGNUP", "");
    vi.stubEnv("REMOLD_WORKSPACE_CREATORS", "");
    const invite = await owner.mutation(api.invites.create, { orgId, role: "member" });
    const invitee = await signIn(t, "invitee", "friend@gmail.com", true);
    expect(await invitee.mutation(api.invites.accept, { token: invite.token })).toBe(orgId);
    expect((await invitee.query(api.orgs.mine, {})).map((row: any) => row.org._id)).toEqual([orgId]);
  });
});
