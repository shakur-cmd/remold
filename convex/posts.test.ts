import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import { api, agentFor, objectFields, rest, userAndOrg } from "./test.helpers";

const DAY = 86_400_000;
// One local day in New York (EDT): from local midnight to the next local midnight minus 1 ms.
const nyDay = (y: number, m: number, d: number) => ({ firstDay: Date.UTC(y, m, d), lastDay: Date.UTC(y, m, d), start: Date.UTC(y, m, d, 4), end: Date.UTC(y, m, d + 1, 4) - 1 });
const metadata = (t: any, orgId: any) => t.run(async (ctx: any) => ({
  objects: (await ctx.db.query("objects").withIndex("by_org", (q: any) => q.eq("orgId", orgId)).collect()),
  fields: (await ctx.db.query("fields").collect()).filter((f: any) => f.orgId === orgId),
}));

async function world() {
  const f = await userAndOrg();
  const post = await objectFields(f.client, f.orgId, "post");
  const values = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).map(([k, x]) => [post.fields[k]._id, x]));
  const create = (v: Record<string, unknown>) => f.client.mutation(api.records.create, { orgId: f.orgId, objectId: post.object._id, values: values(v) });
  const update = (recordId: any, v: Record<string, unknown>) => f.client.mutation(api.records.update, { orgId: f.orgId, recordId, values: values(v) });
  const read = async (id: any) => ((await f.t.run((ctx: any) => ctx.db.get(id))) as any);
  return { ...f, post, values, create, update, read };
}

describe("posts", () => {
  it("new workspaces get Post with channel, planned time, ordered status, text, links and campaign", async () => {
    const { client, orgId } = await userAndOrg();
    const post = await objectFields(client, orgId, "post");
    const campaign = await objectFields(client, orgId, "campaign");
    expect(Object.keys(post.fields)).toEqual(["title", "channel", "planned", "status", "text", "mediaLink", "publishedLink", "campaign"]);
    expect(post.fields.channel.options.map((o: any) => o.id)).toEqual(["tiktok", "instagram", "facebook", "x", "linkedin", "youtube", "other"]);
    expect(post.fields.status.options.map((o: any) => o.id)).toEqual(["idea", "drafted", "approved", "published", "skipped"]);
    expect(post.fields.planned).toMatchObject({ type: "date", withTime: true });
    expect(post.fields.campaign).toMatchObject({ type: "lookup", targetObjectId: campaign.object._id });
    expect(post.object.titleFieldId).toBe(post.fields.title._id);
  });

  it("the migration adds Post to an older workspace, and a second run changes nothing", async () => {
    const { t, orgId } = await userAndOrg();
    await t.run(async (ctx: any) => {
      const post = await ctx.db.query("objects").withIndex("by_org_key", (q: any) => q.eq("orgId", orgId).eq("key", "post")).unique();
      for (const field of await ctx.db.query("fields").withIndex("by_object", (q: any) => q.eq("orgId", orgId).eq("objectId", post._id)).collect()) await ctx.db.delete(field._id);
      await ctx.db.delete(post._id);
    });
    const old = await metadata(t, orgId);
    await t.mutation(internal.seed.ensureStandard, { orgId });
    const once = await metadata(t, orgId);
    const post = once.objects.find((o: any) => o.key === "post");
    expect(post).toMatchObject({ isStandard: true, labelPlural: "Posts" });
    expect(once.fields.filter((f: any) => f.objectId === post._id)).toHaveLength(8);
    for (const before of old.objects) expect(once.objects.find((o: any) => o._id === before._id)).toEqual(before);
    for (const before of old.fields) expect(once.fields.find((f: any) => f._id === before._id)).toEqual(before);
    await t.mutation(internal.seed.ensureStandard, { orgId });
    expect(await metadata(t, orgId)).toEqual(once);
  });

  it("a post cannot be published without its published link", async () => {
    const w = await world();
    await expect(w.create({ title: "Launch reel", status: "published" })).rejects.toMatchObject({ data: { code: "VALIDATION", message: expect.stringMatching(/published link/i) } });
    const { recordId } = await w.create({ title: "Launch reel", status: "approved" });
    await expect(w.update(recordId, { status: "published" })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
    await expect(w.update(recordId, { status: "published", publishedLink: "  " })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
    expect((await w.read(recordId)).values[w.post.fields.status._id]).toBe("approved");
    await w.update(recordId, { status: "published", publishedLink: "https://www.instagram.com/p/abc" });
    expect((await w.read(recordId)).values[w.post.fields.status._id]).toBe("published");
    await expect(w.update(recordId, { publishedLink: null })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
    // The link alone may be pasted first.
    const other = await w.create({ title: "Thread", status: "approved", publishedLink: "https://x.com/s/1" });
    expect((await w.read(other.recordId)).values[w.post.fields.publishedLink._id]).toBe("https://x.com/s/1");
  });

  it("an agent with write grants drafts posts but cannot approve or publish them, and leaves approved and published posts alone", async () => {
    const w = await world();
    const agent = await agentFor(w.client, w.orgId, { name: "drafter", grants: ["create", "update", "delete"].map((action: any) => ({ action, objectKey: "post" })) });
    const call = rest(w.t, agent.key);
    const drafted = await call("POST", "/api/v1/changes", { action: "create", object: "post", values: { title: "Behind the scenes", channel: "tiktok", status: "drafted", text: "Draft copy" }, reason: "draft" });
    expect(drafted.status).toBe(200);
    const id = drafted.json.record.id;
    for (const values of [{ status: "approved" }, { status: "published", publishedLink: "https://tiktok.com/@me/video/1" }]) {
      const res = await call("POST", "/api/v1/changes", { action: "update", record: id, values, reason: "self-approve" });
      expect(res.status).toBe(403);
      expect(res.json.error.message).toMatch(/person/i);
      expect((await call("POST", "/api/v1/suggestions", { action: "update", record: id, values, reason: "self-approve" })).status).toBe(403);
    }
    expect((await call("POST", "/api/v1/changes", { action: "create", object: "post", values: { title: "Pre-approved", status: "approved" }, reason: "x" })).status).toBe(403);
    expect((await w.read(id)).values[w.post.fields.status._id]).toBe("drafted");
    await w.update(id, { status: "approved" });
    expect((await call("POST", "/api/v1/changes", { action: "update", record: id, values: { text: "Sneaky rewrite" }, reason: "edit" })).status).toBe(403);
    expect((await call("POST", "/api/v1/changes", { action: "update", record: id, values: { status: "drafted" }, reason: "edit" })).status).toBe(403);
    expect((await call("POST", "/api/v1/changes", { action: "delete", record: id, reason: "remove" })).status).toBe(403);
    expect((await w.read(id)).values[w.post.fields.text._id]).toBe("Draft copy");
    await w.update(id, { status: "published", publishedLink: "https://tiktok.com/@me/video/1" });
    expect((await call("POST", "/api/v1/changes", { action: "update", record: id, values: { publishedLink: "https://elsewhere" }, reason: "edit" })).status).toBe(403);
  });

  it("Today lists posts planned around today that are not published or skipped, as the caller may read them", async () => {
    const w = await world();
    const today = Date.UTC(2026, 9, 1);
    await w.create({ title: "Morning reel", status: "drafted", planned: today + 14 * 3_600_000 });
    await w.create({ title: "Idea for today", planned: today + 20 * 3_600_000 });
    await w.create({ title: "Already out", status: "published", publishedLink: "https://x.com/s/2", planned: today + 15 * 3_600_000 });
    await w.create({ title: "Dropped", status: "skipped", planned: today + 16 * 3_600_000 });
    await w.create({ title: "Next week", status: "approved", planned: today + 7 * DAY });
    await w.create({ title: "Unplanned", status: "idea" });
    const result = await w.client.query(api.today.get, { orgId: w.orgId, today, start: nyDay(2026, 9, 1).start, end: nyDay(2026, 9, 1).end });
    expect(result.posts.map((r: any) => r.title).sort()).toEqual(["Idea for today", "Morning reel"]);
    expect(result.post).toMatchObject({ objectKey: "post", plannedFieldId: w.post.fields.planned._id });
  });

  it("lists an object's records on the viewer's local days: instants by local time, all-day values by their date", async () => {
    const w = await world();
    const make = (title: string, planned: number) => w.create({ title, planned });
    await make("Oct 4, 11:59 PM", Date.UTC(2026, 9, 5, 3, 59));
    await make("All day Oct 5", Date.UTC(2026, 9, 5));
    await make("Oct 5, 12:00 AM", Date.UTC(2026, 9, 5, 4));
    await make("Oct 5, 8:00 PM", Date.UTC(2026, 9, 6) + 0.5);
    await make("Oct 5, last ms", Date.UTC(2026, 9, 6, 4) - 1);
    await make("All day Oct 6", Date.UTC(2026, 9, 6));
    await make("Oct 6, 12:00 AM", Date.UTC(2026, 9, 6, 4));
    await w.create({ title: "Undated" });
    const range = (window: { firstDay: number; lastDay: number; start: number; end: number }) => w.client.query(api.records.inRange, { orgId: w.orgId, objectId: w.post.object._id, fieldId: w.post.fields.planned._id, ...window });
    const result = await range(nyDay(2026, 9, 5));
    expect(result.records.map((r: any) => r.title)).toEqual(["All day Oct 5", "Oct 5, 12:00 AM", "Oct 5, 8:00 PM", "Oct 5, last ms"]);
    expect(result.truncated).toBe(false);
    // Nov 1 is 25 hours long in New York; 11:30 PM EST is already Nov 2 in UTC.
    await make("Nov 1, 11:30 PM", Date.UTC(2026, 10, 2, 4, 30));
    expect((await range({ firstDay: Date.UTC(2026, 10, 1), lastDay: Date.UTC(2026, 10, 1), start: Date.UTC(2026, 10, 1, 4), end: Date.UTC(2026, 10, 2, 5) - 1 })).records.map((r: any) => r.title)).toEqual(["Nov 1, 11:30 PM"]);
    await expect(w.client.query(api.records.inRange, { orgId: w.orgId, objectId: w.post.object._id, fieldId: w.post.fields.title._id, ...nyDay(2026, 9, 5) })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
  });

  it("Today finds today's post even when earlier days fill the old window", async () => {
    const w = await world();
    for (let i = 0; i < 55; i++) await w.create({ title: `Yesterday ${i}`, status: "drafted", planned: Date.UTC(2026, 9, 4, 12) + i });
    await w.create({ title: "Due today", status: "approved", planned: Date.UTC(2026, 9, 5, 14) });
    const result = await w.client.query(api.today.get, { orgId: w.orgId, today: Date.UTC(2026, 9, 5), start: nyDay(2026, 9, 5).start, end: nyDay(2026, 9, 5).end });
    expect(result.posts.map((r: any) => r.title)).toEqual(["Due today"]);
  });

  it("Post status and published link cannot be retired, and the link rule holds even if one was", async () => {
    const w = await world();
    for (const key of ["status", "publishedLink"]) await expect(w.client.mutation(api.fields.retire, { orgId: w.orgId, fieldId: w.post.fields[key]._id })).rejects.toMatchObject({ data: { message: expect.stringMatching(/cannot be retired/i) } });
    await w.client.mutation(api.fields.retire, { orgId: w.orgId, fieldId: w.post.fields.mediaLink._id });
    // A field retired before this rule existed.
    await w.t.run((ctx: any) => ctx.db.patch(w.post.fields.publishedLink._id, { retired: true }));
    await expect(w.create({ title: "No link", status: "published" })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
    const { recordId } = await w.create({ title: "Approved", status: "approved" });
    await expect(w.update(recordId, { status: "published" })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
  });
});
