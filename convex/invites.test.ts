import { describe, expect, it, vi } from "vitest";
import { api, userAndOrg } from "./test.helpers";

describe("invites", () => {
  it("lets an invited user join once and read the org", async () => {
    const { t, client: a, orgId } = await userAndOrg("a");
    const invite = await a.mutation(api.invites.create, { orgId, role: "member" });
    const b = t.withIdentity({ tokenIdentifier: "clerk|b", name: "B" });
    await b.mutation(api.users.store, {});
    expect(await b.mutation(api.invites.accept, { token: invite.token })).toBe(orgId);
    expect((await b.query(api.orgs.get, { orgId })).name).toBe("a Org");
    expect(await b.mutation(api.invites.accept, { token: invite.token })).toBe(orgId);
  });
  it("expires old invites and keeps members from creating them", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01"));
    const { t, client: a, orgId } = await userAndOrg("owner");
    const invite = await a.mutation(api.invites.create, { orgId, role: "member" });
    vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000);
    const b = t.withIdentity({ tokenIdentifier: "clerk|b", name: "B" }); await b.mutation(api.users.store, {});
    await expect(b.mutation(api.invites.accept, { token: invite.token })).rejects.toMatchObject({ data: { code: "INVITE_EXPIRED" } });
    const current = await a.mutation(api.invites.create, { orgId, role: "member" });
    await b.mutation(api.invites.accept, { token: current.token });
    await expect(b.mutation(api.invites.create, { orgId, role: "member" })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    vi.useRealTimers();
  });
});
