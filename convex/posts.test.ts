import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import { api, agentFor, objectFields, rest, userAndOrg } from "./test.helpers";

const DAY = 86_400_000;
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
    const result = await w.client.query(api.today.get, { orgId: w.orgId, today });
    expect(result.posts.map((r: any) => r.title).sort()).toEqual(["Idea for today", "Morning reel"]);
    expect(result.post).toMatchObject({ objectKey: "post", plannedFieldId: w.post.fields.planned._id });
  });

  it("lists an object's records whose date falls in a range, for the calendar", async () => {
    const w = await world();
    const start = Date.UTC(2026, 9, 1);
    await w.create({ title: "Before", planned: start - 1 });
    await w.create({ title: "First", planned: start });
    await w.create({ title: "Late", planned: start + 30 * DAY - 1 });
    await w.create({ title: "After", planned: start + 30 * DAY });
    await w.create({ title: "Undated" });
    const result = await w.client.query(api.records.inRange, { orgId: w.orgId, objectId: w.post.object._id, fieldId: w.post.fields.planned._id, from: start, to: start + 30 * DAY });
    expect(result.records.map((r: any) => r.title)).toEqual(["First", "Late"]);
    expect(result.truncated).toBe(false);
    const title = await objectFields(w.client, w.orgId, "post");
    await expect(w.client.query(api.records.inRange, { orgId: w.orgId, objectId: w.post.object._id, fieldId: title.fields.title._id, from: start, to: start + DAY })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
  });
});
