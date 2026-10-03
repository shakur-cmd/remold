import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, userAndOrg } from "./test.helpers";
import { zoneDay } from "./lib/zone";

const utc = (...parts: [number, number, number, number?, number?]) => Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3] ?? 0, parts[4] ?? 0);

describe("a workspace day in a time zone", () => {
  it("runs from local midnight to the next, 23 hours long when clocks spring forward", () => {
    const day = zoneDay("America/New_York", utc(2026, 3, 8, 12));
    expect(day).toEqual({ day: utc(2026, 3, 8), start: utc(2026, 3, 8, 5), end: utc(2026, 3, 9, 4) - 1 });
  });
  it("is 25 hours long when clocks fall back", () => {
    const day = zoneDay("America/New_York", utc(2026, 11, 1, 12));
    expect(day).toEqual({ day: utc(2026, 11, 1), start: utc(2026, 11, 1, 4), end: utc(2026, 11, 2, 5) - 1 });
  });
  it("puts an instant on the local date it falls on, not the UTC date", () => {
    expect(zoneDay("America/New_York", utc(2026, 10, 3, 2)).day).toBe(utc(2026, 10, 2));
    expect(zoneDay("Pacific/Auckland", utc(2026, 10, 3, 12)).day).toBe(utc(2026, 10, 4));
    expect(zoneDay("UTC", utc(2026, 10, 3, 23, 59)).day).toBe(utc(2026, 10, 3));
  });
  it("handles zones east of UTC and half-hour offsets", () => {
    expect(zoneDay("Asia/Kolkata", utc(2026, 10, 3, 20))).toEqual({ day: utc(2026, 10, 4), start: utc(2026, 10, 3, 18, 30), end: utc(2026, 10, 4, 18, 30) - 1 });
  });
});

describe("workspace time zone setting", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(utc(2026, 10, 3, 3)); });
  afterEach(() => vi.useRealTimers());

  it("defaults to UTC and is saved in its canonical spelling by an admin", async () => {
    const { client, orgId } = await userAndOrg();
    expect((await client.query(api.orgs.get, { orgId })).timeZone).toBeUndefined();
    expect((await client.query(api.today.get, { orgId })).day.zone).toBe("UTC");
    await client.mutation(api.orgs.setTimeZone, { orgId, timeZone: "america/new_york" });
    expect((await client.query(api.orgs.get, { orgId })).timeZone).toBe("America/New_York");
  });

  it("takes the creator's browser zone when a workspace is created, UTC when it is not a zone", async () => {
    const { t } = await userAndOrg();
    const other = t.withIdentity({ tokenIdentifier: "clerk|Z", name: "Z" });
    await other.mutation(api.users.store, {});
    const zoneOf = async (timeZone: string) => (await other.query(api.orgs.get, { orgId: await other.mutation(api.orgs.create, { name: "Z", timeZone }) })).timeZone;
    expect(await zoneOf("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(await zoneOf("Mars/Olympus")).toBe("UTC");
  });

  it("refuses names that are not time zones", async () => {
    const { client, orgId } = await userAndOrg();
    for (const timeZone of ["Mars/Olympus", "", "+05:00", "  ", "New York"]) await expect(client.mutation(api.orgs.setTimeZone, { orgId, timeZone })).rejects.toThrow();
    expect((await client.query(api.orgs.get, { orgId })).timeZone).toBeUndefined();
  });

  it("is for admins only", async () => {
    const { t, client, orgId } = await userAndOrg();
    const invite = await client.mutation(api.invites.create, { orgId, role: "member" });
    const other = t.withIdentity({ tokenIdentifier: "clerk|M", name: "M" });
    await other.mutation(api.users.store, {});
    await other.mutation(api.invites.accept, { token: invite.token });
    await expect(other.mutation(api.orgs.setTimeZone, { orgId, timeZone: "Asia/Tokyo" })).rejects.toThrow();
  });

  it("moves Today's day boundary: 03:00 UTC on Oct 3 is still Oct 2 in New York", async () => {
    const { client, orgId } = await userAndOrg();
    expect((await client.query(api.today.get, { orgId })).day).toMatchObject({ today: utc(2026, 10, 3), start: utc(2026, 10, 3) });
    await client.mutation(api.orgs.setTimeZone, { orgId, timeZone: "America/New_York" });
    expect((await client.query(api.today.get, { orgId })).day).toEqual({ zone: "America/New_York", today: utc(2026, 10, 2), start: utc(2026, 10, 2, 4), end: utc(2026, 10, 3, 4) - 1 });
  });
});
