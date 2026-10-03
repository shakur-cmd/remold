import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { internal } from "./_generated/api";
import { agentFor, api, objectFields, rest } from "./test.helpers";
import { makeTest } from "./test.setup";
import crons from "./crons";

// Campaign email: people approve, Remold sends through Resend (mocked here), and
// opens, clicks, bounces, replies and unsubscribes come back through a signed webhook.
const MINUTE = 60_000, DAY = 86_400_000, start = Date.UTC(2026, 9, 5, 14);
const SECRET_KEY = Buffer.from("campaign-webhook-test-secret-key");
const env = { RESEND_API_KEY: "re_test_key", REMOLD_SENDER_DOMAINS: "mail.example.com, other.example.com", REMOLD_CAMPAIGN_DAILY_CAP: "100", CONVEX_SITE_URL: "https://site.example.com", RESEND_WEBHOOK_SECRET: `whsec_${SECRET_KEY.toString("base64")}` };
const ENV_KEYS = [...Object.keys(env), "REMOLD_INBOUND_DOMAIN"];

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
let calls: Call[], delivered: Call[], byKey: Map<string, string>, inbound: string;
let failWith: ((call: Call) => Response | undefined) | undefined, onSend: ((call: Call) => Promise<void>) | undefined;
// A fake Resend: an Idempotency-Key it has seen returns the first answer and sends nothing new.
async function fakeResend(url: string, init: any = {}) {
  const call: Call = { url: String(url), method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body ? JSON.parse(init.body) : undefined };
  calls.push(call);
  if (call.method === "GET" && call.url.startsWith("https://api.resend.com/emails/receiving/")) return Response.json({ object: "email", id: call.url.split("/").pop(), text: inbound });
  await onSend?.(call);
  const failure = failWith?.(call);
  if (failure) return failure;
  const key = call.headers["idempotency-key"];
  if (key && byKey.has(key)) return Response.json({ id: byKey.get(key) });
  const id = `re_${delivered.length + 1}`;
  if (key) byKey.set(key, id);
  delivered.push(call);
  return Response.json({ id });
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(start); Object.assign(process.env, env);
  calls = []; delivered = []; byKey = new Map(); inbound = ""; failWith = undefined; onSend = undefined;
  vi.stubGlobal("fetch", vi.fn(fakeResend));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const key of ENV_KEYS) delete process.env[key]; });

const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
const to = (call: Call) => call.body.to[0] as string;

async function world(options: { t?: any; name?: string; people?: string[]; limit?: number } = {}) {
  const t = options.t ?? makeTest(), name = options.name ?? "Owner";
  const client = t.withIdentity({ tokenIdentifier: `clerk|${name}`, name, email: `${name.toLowerCase()}@example.com` });
  await client.mutation(api.users.store, {});
  const orgId = await client.mutation(api.orgs.create, { name: `${name} Co` });
  const [person, company, campaign, email, activity, note] = await Promise.all(["person", "company", "campaign", "email", "activity", "note"].map((key) => objectFields(client, orgId, key)));
  const ids = (o: any, values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [o.fields[key]._id, value]));
  const create = async (o: any, values: Record<string, unknown>) => (await client.mutation(api.records.create, { orgId, objectId: o.object._id, values: ids(o, values) })).recordId;
  const update = (o: any, recordId: any, values: Record<string, unknown>) => client.mutation(api.records.update, { orgId, recordId, values: ids(o, values) });
  const acme = await create(company, { name: "Acme Plumbing" });
  const people: Record<string, any> = {};
  for (const full of options.people ?? ["Ava Stone", "Ben Ortiz"]) people[full.split(" ")[0]!] = await create(person, { name: full, email: `${full.split(" ")[0]!.toLowerCase()}@people.test`, company: acme });
  const campaignId = await create(campaign, { name: "Five dollar calls", status: "active", channel: "email", people: Object.values(people) });
  const settings = { orgId, fromName: `${name} Co`, fromAddress: "hi@mail.example.com", postalAddress: "1 Main St, Springfield", dailyLimit: options.limit ?? 50 };
  const save = (change: Record<string, unknown> = {}) => client.mutation(api.campaigns.saveSettings, { ...settings, ...change });
  await save();
  const draft = (values: Record<string, unknown>) => create(email, { status: "draft", campaign: campaignId, ...values });
  const approve = (emailId: any) => client.mutation(api.campaigns.approve, { orgId, emailId, confirmed: true });
  const first = await draft({ subject: "Quick call, {{firstName|there}}?", body: "Hi {{firstName|there}},\n\nFive minutes for $5 at {{company}}? https://example.com/book" });
  await approve(first);
  const read = (id: any) => t.run((ctx: any) => ctx.db.get(id));
  const sends = async (emailId: any = first) => (await t.run((ctx: any) => ctx.db.query("emailSends").collect())).filter((s: any) => s.emailRecordId === emailId);
  const sendTo = async (who: string, emailId: any = first) => (await sends(emailId)).find((s: any) => s.personRecordId === people[who]);
  const titlesAbout = async (o: any, recordId: any) => (await t.run((ctx: any) => ctx.db.query("records").collect())).filter((r: any) => r.objectId === o.object._id && r.values[o.fields.about._id] === recordId).map((r: any) => r.title);
  return { t, client, orgId, person, company, campaign, email, activity, note, people, campaignId, first, create, update, save, draft, approve, read, sends, sendTo, titlesAbout };
}
const tick = (t: any) => t.action(internal.campaignSend.tick, {});

const sign = (id: string, ts: string, body: string, key: Uint8Array = SECRET_KEY) => `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;
let hookId = 0;
async function hook(t: any, event: unknown, options: { id?: string; ts?: number; key?: Buffer; signature?: string } = {}) {
  const body = JSON.stringify(event), id = options.id ?? `msg_${++hookId}`, ts = String(options.ts ?? Math.floor(Date.now() / 1000));
  const response = await t.fetch("/webhooks/resend", { method: "POST", headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": ts, "svix-signature": options.signature ?? sign(id, ts, body, options.key) }, body });
  return response.status;
}
const tracked = (type: string, send: any, data: Record<string, unknown> = {}) => ({ type, created_at: new Date().toISOString(), data: { email_id: send.providerId, tags: { send: send._id }, ...data } });

describe("campaign email", () => {
  it("runs the sender every minute", () => {
    expect(Object.values((crons as any).crons)).toContainEqual(expect.objectContaining({ name: "campaignSend:tick", schedule: { type: "cron", cron: "* * * * *" } }));
  });

  it("new workspaces get Email steps, and the migration adds them to an older workspace once", async () => {
    const t = makeTest(), w = await world({ t });
    expect(Object.keys(w.email.fields)).toEqual(["subject", "body", "campaign", "followsUp", "waitDays", "sendTo", "sendAt", "status"]);
    expect(w.email.object.titleFieldId).toBe(w.email.fields.subject._id);
    expect(w.email.fields.body.slot).toBeUndefined();
    expect(w.email.fields.status.slot).toMatchObject({ kind: "s" });
    expect(w.email.fields.campaign).toMatchObject({ type: "lookup", targetObjectId: w.campaign.object._id, slot: { kind: "s" } });
    expect(w.email.fields.followsUp).toMatchObject({ type: "lookup", targetObjectId: w.email.object._id });
    expect(w.email.fields.status.options.map((o: any) => o.id)).toEqual(["draft", "approved", "sending", "sent", "stopped"]);
    expect(w.email.fields.sendTo.options.map((o: any) => o.id)).toEqual(["everyone", "notOpened", "notClicked", "notReplied"]);
    const snapshot = () => t.run(async (ctx: any) => ({ objects: await ctx.db.query("objects").collect(), fields: await ctx.db.query("fields").collect() }));
    await t.run(async (ctx: any) => {
      for (const field of await ctx.db.query("fields").collect()) if (field.objectId === w.email.object._id) await ctx.db.delete(field._id);
      await ctx.db.delete(w.email.object._id);
    });
    const old = await snapshot();
    await t.mutation(internal.seed.ensureStandard, { orgId: w.orgId });
    const once = await snapshot();
    const added = once.objects.find((o: any) => o.orgId === w.orgId && o.key === "email");
    expect(added).toMatchObject({ isStandard: true, labelPlural: "Emails" });
    expect(once.fields.filter((f: any) => f.objectId === added._id)).toHaveLength(8);
    for (const before of old.fields) expect(once.fields.find((f: any) => f._id === before._id)).toEqual(before);
    await t.mutation(internal.seed.ensureStandard, { orgId: w.orgId });
    expect(await snapshot()).toEqual(once);
  });

  it("the fields the sender needs cannot be retired", async () => {
    const w = await world();
    for (const key of ["body", "campaign", "followsUp", "status"]) await expect(w.client.mutation(api.fields.retire, { orgId: w.orgId, fieldId: w.email.fields[key]._id })).rejects.toMatchObject({ data: { message: expect.stringMatching(/cannot be retired/i) } });
    await w.client.mutation(api.fields.retire, { orgId: w.orgId, fieldId: w.email.fields.sendAt._id });
  });

  describe("sending", () => {
    it("sends an approved email once to each person on an active campaign, with footer, unsubscribe headers and a timeline entry", async () => {
      const w = await world();
      await tick(w.t);
      expect(delivered.map(to).sort()).toEqual(["ava@people.test", "ben@people.test"]);
      const ava = await w.sendTo("Ava");
      const mail = delivered.find((call) => to(call) === "ava@people.test")!;
      expect(mail.url).toBe("https://api.resend.com/emails");
      expect(mail.headers.authorization).toBe("Bearer re_test_key");
      expect(mail.headers["idempotency-key"]).toBe(ava._id);
      expect(mail.body).toMatchObject({ from: "Owner Co <hi@mail.example.com>", subject: "Quick call, Ava?", reply_to: "owner@example.com", tags: [{ name: "send", value: ava._id }] });
      expect(mail.body.text).toContain("Hi Ava,\n\nFive minutes for $5 at Acme Plumbing? https://example.com/book");
      expect(mail.body.text).toContain("1 Main St, Springfield");
      expect(mail.body.text).toContain(`https://site.example.com/u/${ava.token}`);
      expect(mail.body.html).toContain('<a href="https://example.com/book">https://example.com/book</a>');
      expect(mail.body.html).toContain("<br>");
      expect(mail.body.headers).toEqual({ "List-Unsubscribe": `<https://site.example.com/u/${ava.token}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
      expect(ava).toMatchObject({ status: "sent", providerId: mail.body && byKey.get(ava._id), sentAt: start, attempts: 1 });
      expect(ava.token).toMatch(/^[a-z0-9]{32,}$/);
      expect((await w.read(w.first)).values[w.email.fields.status._id]).toBe("sent");
      expect(await w.titlesAbout(w.activity, w.people.Ava)).toEqual(["Sent: Quick call, Ava?"]);
      await tick(w.t);
      later(DAY);
      await tick(w.t);
      expect(delivered).toHaveLength(2);
    });

    const gates: [string, (w: Awaited<ReturnType<typeof world>>) => Promise<unknown>][] = [
      ["the Resend API key is set", async () => delete process.env.RESEND_API_KEY],
      ["sender domains are allowed", async () => delete process.env.REMOLD_SENDER_DOMAINS],
      ["the from address is on an allowed domain", (w) => w.save({ fromAddress: "hi@elsewhere.example.com" })],
      ["the webhook secret is set, so bounces and complaints come back", async () => delete process.env.RESEND_WEBHOOK_SECRET],
      ["the org has a postal address", (w) => w.save({ postalAddress: "" })],
      ["the org has a daily limit", (w) => w.save({ dailyLimit: 0 })],
      ["the deployment has a daily cap", async () => delete process.env.REMOLD_CAMPAIGN_DAILY_CAP],
      ["the deployment cap is a whole number", async () => { process.env.REMOLD_CAMPAIGN_DAILY_CAP = "1e3"; }],
      ["the campaign is active", (w) => w.update(w.campaign, w.campaignId, { status: "paused" })],
      ["the email is approved", (w) => w.update(w.email, w.first, { status: "draft" })],
      ["a person approved it on the campaign page", async (w) => { await w.update(w.email, w.first, { status: "draft" }); await w.update(w.email, w.first, { status: "approved" }); }],
      ["its send time has come", (w) => w.update(w.email, w.first, { sendAt: start + DAY })],
    ];
    for (const [gate, remove] of gates) it(`sends nothing unless ${gate}`, async () => {
      const w = await world();
      await remove(w);
      await tick(w.t);
      expect(delivered).toEqual([]);
      expect((await w.sends()).filter((s: any) => s.status === "sent")).toEqual([]);
    });

    it("skips people without a usable or allowed address and sends to a shared address once", async () => {
      const w = await world({ people: ["Ava Stone"] });
      const none = await w.create(w.person, { name: "No Mail" }), bad = await w.create(w.person, { name: "Bad Mail", email: "not-an-address" });
      const twin = await w.create(w.person, { name: "Ava Twin", email: " AVA@people.test " });
      const gone = await w.create(w.person, { name: "Gone Person", email: "gone@people.test" });
      await w.t.run((ctx: any) => ctx.db.insert("consent", { orgId: w.orgId, recipient: "gone@people.test", channel: "email", purpose: "marketing", suppressed: true, source: "unsubscribe", version: 1, at: start }));
      await w.update(w.campaign, w.campaignId, { people: [w.people.Ava, none, bad, twin, gone] });
      await tick(w.t);
      expect(delivered.map(to)).toEqual(["ava@people.test"]);
      const reasons = Object.fromEntries((await w.sends()).map((s: any) => [s.personRecordId, s.skipReason ?? s.status]));
      expect(reasons).toEqual({ [w.people.Ava]: "sent", [none]: "no email", [bad]: "invalid address", [twin]: "duplicate address", [gone]: "unsubscribed" });
    });

    it("never goes past the org's daily limit, even with ticks running at once, and goes on the next UTC day", async () => {
      const w = await world({ people: ["A1 x", "A2 x", "A3 x", "A4 x", "A5 x", "A6 x", "A7 x"], limit: 3 });
      await Promise.all([tick(w.t), tick(w.t), tick(w.t)]);
      await tick(w.t);
      expect(delivered).toHaveLength(3);
      vi.setSystemTime(Date.UTC(2026, 9, 6, 0, 1));
      await Promise.all([tick(w.t), tick(w.t)]);
      expect(delivered).toHaveLength(6);
    });

    it("never goes past the deployment's daily cap across workspaces", async () => {
      process.env.REMOLD_CAMPAIGN_DAILY_CAP = "4";
      const t = makeTest();
      await world({ t, name: "One", people: ["A1 x", "A2 x", "A3 x"] });
      await world({ t, name: "Two", people: ["B1 x", "B2 x", "B3 x"] });
      await Promise.all([tick(t), tick(t), tick(t)]);
      expect(delivered).toHaveLength(4);
    });

    it("stops the rest of a batch when the campaign is paused mid-batch, and finishes after it restarts", async () => {
      const w = await world({ people: ["A1 x", "A2 x", "A3 x", "A4 x"] });
      onSend = async () => { if (delivered.length === 0) await w.update(w.campaign, w.campaignId, { status: "paused" }); };
      await tick(w.t);
      expect(delivered).toHaveLength(1);
      expect((await w.sends()).filter((s: any) => s.status === "sent")).toHaveLength(1);
      onSend = undefined;
      await tick(w.t);
      expect(delivered).toHaveLength(1);
      await w.update(w.campaign, w.campaignId, { status: "active" });
      await tick(w.t);
      expect(delivered).toHaveLength(4);
    });

    it("an email stopped mid-batch sends nothing more", async () => {
      const w = await world({ people: ["A1 x", "A2 x", "A3 x"] });
      onSend = async () => { if (delivered.length === 0) await w.update(w.email, w.first, { status: "stopped" }); };
      await tick(w.t);
      onSend = undefined;
      later(MINUTE);
      await tick(w.t);
      expect(delivered).toHaveLength(1);
      expect((await w.read(w.first)).values[w.email.fields.status._id]).toBe("stopped");
    });

    it("a claim whose sender crashed is retried with the same idempotency key after its lease, so nobody gets it twice", async () => {
      const w = await world();
      const claimed = await w.t.mutation(internal.campaignSend.claim, {});
      expect(claimed).toHaveLength(2);
      // The crashed run reached Resend for the first person before it died.
      await fetch("https://api.resend.com/emails", { method: "POST", headers: { "idempotency-key": claimed[0].sendId }, body: JSON.stringify({ to: [claimed[0].mail.to] }) });
      await tick(w.t);
      expect(delivered).toHaveLength(1);
      expect((await w.sends()).map((s: any) => s.status)).toEqual(["sending", "sending"]);
      later(10 * MINUTE);
      await tick(w.t);
      expect(delivered).toHaveLength(2);
      expect(new Set(delivered.map((call) => call.headers["idempotency-key"])).size).toBe(2);
      const rows = await w.sends();
      expect(rows.map((s: any) => [s.status, s.attempts])).toEqual([["sent", 2], ["sent", 2]]);
      expect(rows.find((s: any) => s._id === claimed[0].sendId).providerId).toBe("re_1");
    });

    it("retries rate limits and server errors up to three attempts, and fails at once on a refusal", async () => {
      const w = await world();
      failWith = (call) => to(call) === "ava@people.test" ? new Response("{}", { status: 503 }) : new Response(JSON.stringify({ message: "Invalid `to` field" }), { status: 422 });
      await tick(w.t);
      expect(await w.sendTo("Ben")).toMatchObject({ status: "failed", attempts: 1 });
      expect(await w.sendTo("Ava")).toMatchObject({ status: "queued", attempts: 1 });
      later(MINUTE); await tick(w.t);
      later(MINUTE); await tick(w.t);
      expect(await w.sendTo("Ava")).toMatchObject({ status: "failed", attempts: 3 });
      later(MINUTE); await tick(w.t);
      expect(calls.filter((call) => call.method === "POST" && to(call) === "ava@people.test")).toHaveLength(3);
      expect((await w.read(w.first)).values[w.email.fields.status._id]).toBe("sent");
    });

    it("a follow-up for people who did not open goes after its wait, never to anyone who replied, unsubscribed or wrote back", async () => {
      process.env.REMOLD_INBOUND_DOMAIN = "reply.example.com";
      const w = await world({ people: ["Ava Stone", "Ben Ortiz", "Cy Diaz", "Dee Park", "Eve Lund"] });
      await tick(w.t);
      expect(delivered).toHaveLength(5);
      const next = await w.draft({ subject: "Still keen?", body: "Hi {{firstName}}, just checking.", followsUp: w.first, waitDays: 3, sendTo: "notOpened" });
      await w.approve(next);
      expect(await hook(w.t, tracked("email.opened", await w.sendTo("Ben")))).toBe(200);
      await w.client.mutation(api.campaigns.markReplied, { orgId: w.orgId, sendId: (await w.sendTo("Cy"))._id });
      expect((await w.t.fetch(`/u/${(await w.sendTo("Dee")).token}`, { method: "POST" })).status).toBe(200);
      // Gmail sync recorded a message from Eve after the campaign email went out.
      later(DAY);
      await w.create(w.activity, { title: "Email received", type: "email", when: Date.now(), about: w.people.Eve, source: "gmail:abc" });
      later(DAY);
      await tick(w.t);
      expect(delivered).toHaveLength(5);
      later(DAY + MINUTE);
      await tick(w.t);
      expect(delivered.slice(5).map(to)).toEqual(["ava@people.test"]);
      expect(delivered[5]!.body.subject).toBe("Still keen?");
      const reasons = Object.fromEntries((await w.sends(next)).map((s: any) => [s.personRecordId, s.skipReason ?? s.status]));
      expect(reasons).toEqual({ [w.people.Ava]: "sent", [w.people.Ben]: "opened", [w.people.Cy]: "replied", [w.people.Dee]: "unsubscribed", [w.people.Eve]: "replied" });
      expect((await w.read(next)).values[w.email.fields.status._id]).toBe("sent");
    });

    it("a follow-up waits for the email before it, and is not sent while that one is still going out", async () => {
      const w = await world();
      const next = await w.draft({ subject: "Again", body: "Hello again", followsUp: w.first, waitDays: 0, sendTo: "everyone" });
      await w.approve(next);
      await w.update(w.campaign, w.campaignId, { status: "paused" });
      await tick(w.t);
      await w.update(w.campaign, w.campaignId, { status: "active" });
      await tick(w.t);
      expect(delivered.map((call) => call.body.subject)).toEqual(["Quick call, Ava?", "Quick call, Ben?"]);
      later(MINUTE);
      await tick(w.t);
      expect(delivered.slice(2).map((call) => call.body.subject)).toEqual(["Again", "Again"]);
    });
  });

  describe("tracking webhook", () => {
    it("refuses a missing secret, a bad or foreign signature and a stale timestamp, writing nothing, and counts a replayed event once", async () => {
      const w = await world({ people: ["Ava Stone"] });
      await tick(w.t);
      const ava = await w.sendTo("Ava"), event = tracked("email.opened", ava);
      const state = () => w.t.run(async (ctx: any) => ({ sends: await ctx.db.query("emailSends").collect(), seen: await ctx.db.query("webhookEvents").collect() }));
      const before = await state();
      delete process.env.RESEND_WEBHOOK_SECRET;
      expect(await hook(w.t, event)).toBe(503);
      process.env.RESEND_WEBHOOK_SECRET = env.RESEND_WEBHOOK_SECRET;
      expect(await hook(w.t, event, { signature: "v1,bm90IGEgc2lnbmF0dXJl" })).toBe(401);
      expect(await hook(w.t, event, { key: Buffer.from("some-other-secret") })).toBe(401);
      expect(await hook(w.t, event, { ts: Math.floor(Date.now() / 1000) - 6 * 60 })).toBe(401);
      expect(await hook(w.t, event, { ts: Math.floor(Date.now() / 1000) + 6 * 60 })).toBe(401);
      expect(await state()).toEqual(before);
      expect(await hook(w.t, event, { id: "msg_same" })).toBe(200);
      expect(await hook(w.t, event, { id: "msg_same" })).toBe(200);
      expect(await w.sendTo("Ava")).toMatchObject({ opens: 1, openedAt: start });
      later(MINUTE);
      // Matched by Resend's id when the tag is missing.
      expect(await hook(w.t, { type: "email.opened", data: { email_id: ava.providerId } })).toBe(200);
      expect(await w.sendTo("Ava")).toMatchObject({ opens: 2, openedAt: start });
    });

    it("records delivery and clicks, with a timeline entry on the first click only", async () => {
      const w = await world({ people: ["Ava Stone"] });
      await tick(w.t);
      const ava = await w.sendTo("Ava");
      await hook(w.t, tracked("email.delivered", ava));
      later(MINUTE);
      await hook(w.t, tracked("email.clicked", ava, { click: { link: "https://example.com/book" } }));
      await hook(w.t, tracked("email.clicked", ava, { click: { link: "https://example.com/pay" } }));
      expect(await w.sendTo("Ava")).toMatchObject({ deliveredAt: start, clicks: 2, clickedAt: start + MINUTE, lastLink: "https://example.com/pay" });
      expect((await w.titlesAbout(w.activity, w.people.Ava)).sort()).toEqual(["Clicked: Quick call, Ava?", "Sent: Quick call, Ava?"]);
    });

    it("a permanent bounce and a complaint suppress the address; a temporary bounce does not", async () => {
      const w = await world({ people: ["Ava Stone", "Ben Ortiz", "Cy Diaz"] });
      await tick(w.t);
      await hook(w.t, tracked("email.bounced", await w.sendTo("Ava"), { bounce: { type: "Permanent", message: "No such user" } }));
      await hook(w.t, tracked("email.bounced", await w.sendTo("Ben"), { bounce: { type: "Transient", message: "Mailbox full" } }));
      await hook(w.t, tracked("email.complained", await w.sendTo("Cy")));
      const consent = await w.t.run((ctx: any) => ctx.db.query("consent").collect());
      expect(consent.map((c: any) => [c.recipient, c.source, c.suppressed, c.channel, c.purpose]).sort()).toEqual([["ava@people.test", "bounce", true, "email", "marketing"], ["cy@people.test", "complaint", true, "email", "marketing"]]);
      expect((await w.sendTo("Ava")).bouncedAt).toBe(start);
      expect((await w.sendTo("Ben")).bouncedAt).toBeUndefined();
      expect(await w.titlesAbout(w.activity, w.people.Ava)).toContain("Bounced: Quick call, Ava?");
      // A new campaign to the same people leaves the suppressed ones out.
      const other = await w.create(w.campaign, { name: "Second", status: "active", people: Object.values(w.people) });
      const second = await w.create(w.email, { subject: "Hello", body: "Hi", campaign: other, status: "draft" });
      const preview = await w.client.query(api.campaigns.preview, { orgId: w.orgId, emailId: second });
      expect(preview.recipients.map((r: any) => r.address)).toEqual(["ben@people.test"]);
      expect(preview.excluded.map((r: any) => [r.address, r.reason]).sort()).toEqual([["ava@people.test", "bounced"], ["cy@people.test", "complained"]]);
    });
  });

  describe("replies and unsubscribes", () => {
    it("the unsubscribe link asks first; only the button unsubscribes, once, and an unknown link looks the same", async () => {
      const w = await world({ people: ["Ava Stone"] });
      await tick(w.t);
      const token = (await w.sendTo("Ava")).token;
      const page = await w.t.fetch(`/u/${token}`);
      const html = await page.text();
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(html).toMatch(/<form method="post"/i);
      expect(html).toContain("Unsubscribe");
      expect((await w.sendTo("Ava")).unsubscribedAt).toBeUndefined();
      expect(await w.t.run((ctx: any) => ctx.db.query("consent").collect())).toEqual([]);
      const unknown = await w.t.fetch(`/u/${"x".repeat(32)}`);
      expect(await unknown.text()).toBe(html);
      const done = await w.t.fetch(`/u/${token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
      const doneHtml = await done.text();
      expect(doneHtml).toContain("You are unsubscribed");
      later(MINUTE);
      expect(await (await w.t.fetch(`/u/${token}`, { method: "POST" })).text()).toBe(doneHtml);
      expect(await (await w.t.fetch(`/u/${"x".repeat(32)}`, { method: "POST" })).text()).toBe(doneHtml);
      expect((await w.sendTo("Ava")).unsubscribedAt).toBe(start);
      expect((await w.t.run((ctx: any) => ctx.db.query("consent").collect())).map((c: any) => [c.recipient, c.source])).toEqual([["ava@people.test", "unsubscribe"]]);
      expect((await w.titlesAbout(w.activity, w.people.Ava)).filter((title: string) => title.startsWith("Unsubscribed"))).toHaveLength(1);
    });

    it("a reply to the inbound address marks the send replied, keeps the reply as a note and forwards it to the org", async () => {
      process.env.REMOLD_INBOUND_DOMAIN = "reply.example.com";
      const w = await world({ people: ["Ava Stone"] });
      await tick(w.t);
      const ava = await w.sendTo("Ava");
      expect(delivered[0]!.body.reply_to).toBe(`r-${ava.token}@reply.example.com`);
      inbound = "Yes please, Tuesday works.\n\nOn Mon, Oct 5, 2026 at 9:00 AM Owner Co <hi@mail.example.com> wrote:\n> Hi Ava,\n> Five minutes";
      later(MINUTE);
      expect(await hook(w.t, { type: "email.received", data: { email_id: "in_1", from: "Ava Stone <ava@people.test>", to: [`r-${ava.token}@reply.example.com`], subject: "Re: Quick call, Ava?" } }, { id: "msg_reply" })).toBe(200);
      expect(await hook(w.t, { type: "email.received", data: { email_id: "in_1", from: "Ava Stone <ava@people.test>", to: [`r-${ava.token}@reply.example.com`], subject: "Re: Quick call, Ava?" } }, { id: "msg_reply" })).toBe(200);
      expect(calls.filter((call) => call.url === "https://api.resend.com/emails/receiving/in_1")).toHaveLength(1);
      expect(calls.find((call) => call.method === "GET")!.headers.authorization).toBe("Bearer re_test_key");
      expect((await w.sendTo("Ava")).repliedAt).toBe(start + MINUTE);
      expect(await w.titlesAbout(w.note, w.people.Ava)).toEqual(["Yes please, Tuesday works."]);
      expect(await w.titlesAbout(w.activity, w.people.Ava)).toContain("Replied: Quick call, Ava?");
      const forwarded = delivered.slice(1);
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]!.body).toMatchObject({ from: "Owner Co <hi@mail.example.com>", to: ["owner@example.com"], reply_to: "ava@people.test", subject: "Re: Quick call, Ava?" });
      expect(forwarded[0]!.body.text).toContain("Yes please, Tuesday works.");
    });

    it("without an inbound domain, replies go to the org's reply-to address", async () => {
      const w = await world({ people: ["Ava Stone"] });
      await w.save({ replyTo: "sales@example.com" });
      await tick(w.t);
      expect(delivered[0]!.body.reply_to).toBe("sales@example.com");
    });
  });

  describe("approval", () => {
    it("checks subject, body, merge tags, campaign and the email it follows on every approval path", async () => {
      const w = await world();
      const bad = async (values: Record<string, unknown>) => {
        const id = await w.draft(values);
        await expect(w.approve(id)).rejects.toMatchObject({ data: { code: "VALIDATION" } });
        await expect(w.update(w.email, id, { status: "approved" })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
        expect((await w.read(id)).values[w.email.fields.status._id]).toBe("draft");
      };
      await bad({ subject: "Hi", body: "Hi {{first_name}}" });
      await bad({ subject: "Hi {{lastName}}", body: "Hi" });
      await bad({ subject: "Hi", body: "Hi {{firstName" + "}} {{ }}" });
      await bad({ subject: "Hi" });
      await bad({ subject: "Hi", body: "  " });
      await bad({ subject: "Hi", body: "Hi", campaign: null });
      const other = await w.create(w.campaign, { name: "Other" });
      const elsewhere = await w.create(w.email, { subject: "Elsewhere", body: "x", campaign: other, status: "draft" });
      await bad({ subject: "Hi", body: "Hi", followsUp: elsewhere });
      const fine = await w.draft({ subject: "Hi {{name}}", body: "Hello {{firstName|friend}} at {{company|your company}}", followsUp: w.first });
      await expect(w.client.mutation(api.campaigns.approve, { orgId: w.orgId, emailId: fine, confirmed: false })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
      await w.approve(fine);
      expect((await w.read(fine)).values[w.email.fields.status._id]).toBe("approved");
      await expect(w.update(w.email, fine, { body: "Now {{oops}}" })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
    });

    it("an agent drafts emails and may stop one, but cannot approve, start a campaign or touch an approved email", async () => {
      const w = await world();
      const agent = await agentFor(w.client, w.orgId, { name: "drafter", grants: [...["create", "update", "delete"].map((action: any) => ({ action, objectKey: "email" })), { action: "update", objectKey: "campaign" }] });
      const call = rest(w.t, agent.key);
      const change = (body: Record<string, unknown>) => call("POST", "/api/v1/changes", { reason: "test", ...body });
      const drafted = await change({ action: "create", object: "email", values: { subject: "Hello {{firstName}}", body: "Short note", campaign: w.campaignId, status: "draft" } });
      expect(drafted.status).toBe(200);
      const id = drafted.json.record.id;
      expect((await change({ action: "update", record: id, values: { body: "Shorter note" } })).status).toBe(200);
      for (const status of ["approved", "sending", "sent"]) {
        const refused = await change({ action: "update", record: id, values: { status } });
        expect(refused.status).toBe(403);
        expect(refused.json.error.message).toMatch(/person/i);
        expect((await call("POST", "/api/v1/suggestions", { action: "update", record: id, values: { status }, reason: "x" })).status).toBe(403);
      }
      expect((await change({ action: "create", object: "email", values: { subject: "Pre-approved", body: "x", campaign: w.campaignId, status: "approved" } })).status).toBe(403);
      await w.update(w.campaign, w.campaignId, { status: "paused" });
      expect((await change({ action: "update", record: w.campaignId, values: { status: "active" } })).status).toBe(403);
      await w.update(w.campaign, w.campaignId, { status: "active" });
      expect((await change({ action: "update", record: w.campaignId, values: { status: "paused" } })).status).toBe(200);
      await w.approve(id);
      for (const values of [{ body: "Sneaky rewrite" }, { status: "draft" }, { subject: "New subject" }]) expect((await change({ action: "update", record: id, values })).status).toBe(403);
      expect((await change({ action: "delete", record: id })).status).toBe(403);
      expect((await change({ action: "update", record: id, values: { status: "stopped" } })).status).toBe(200);
      expect((await w.read(id)).values[w.email.fields.body._id]).toBe("Shorter note");
    });
  });

  describe("agents", () => {
    it("the report shows each email's numbers and gate problems, and recipients only as far as the key may read", async () => {
      const w = await world();
      await tick(w.t);
      await hook(w.t, tracked("email.opened", await w.sendTo("Ava")));
      const follow = await w.draft({ subject: "Follow", body: "x", followsUp: w.first });
      const agent = await agentFor(w.client, w.orgId, { name: "reader" });
      const campaignRef = (await w.read(w.campaignId)).ref;
      const report = await rest(w.t, agent.key)("GET", `/api/v1/campaigns/${campaignRef}/report`);
      expect(report.status).toBe(200);
      const [sent, draft] = report.json.emails;
      expect(sent).toMatchObject({ subject: "Quick call, {{firstName|there}}?", status: "sent", counts: { recipients: 2, sent: 2, opened: 1, clicked: 0, replied: 0, bounced: 0, unsubscribed: 0 }, rates: { opened: 0.5, clicked: 0 } });
      expect(sent.recipients.map((r: any) => [r.name, r.address, r.status, r.opened]).sort()).toEqual([["Ava Stone", "ava@people.test", "sent", true], ["Ben Ortiz", "ben@people.test", "sent", false]]);
      expect(sent.recipients[0].person.ref).toMatch(/-/);
      expect(draft).toMatchObject({ id: follow, status: "draft" });
      expect(draft.problems).toContain("Not approved yet");
      // No read on People: numbers stay, recipients go.
      const noPeople = await agentFor(w.client, w.orgId, { name: "no people" });
      await w.t.run((ctx: any) => ctx.db.patch(noPeople.agentId, { readObjectIds: [w.campaign.object._id, w.email.object._id] }));
      const masked = await rest(w.t, noPeople.key)("GET", `/api/v1/campaigns/${w.campaignId}/report`);
      expect(masked.status).toBe(200);
      expect(masked.json.emails[0].counts.sent).toBe(2);
      expect(masked.json.emails[0].recipients).toEqual([]);
      // A hidden Email field hides the address but not the person.
      const hidden = await agentFor(w.client, w.orgId, { name: "hidden" });
      await w.t.run((ctx: any) => ctx.db.patch(hidden.agentId, { hiddenFieldIds: [w.person.fields.email._id] }));
      expect((await rest(w.t, hidden.key)("GET", `/api/v1/campaigns/${w.campaignId}/report`)).json.emails[0].recipients.map((r: any) => r.address)).toEqual([null, null]);
      // No read on Campaigns: the campaign does not exist for this key.
      const noCampaigns = await agentFor(w.client, w.orgId, { name: "no campaigns" });
      await w.t.run((ctx: any) => ctx.db.patch(noCampaigns.agentId, { readObjectIds: [w.person.object._id, w.email.object._id] }));
      expect((await rest(w.t, noCampaigns.key)("GET", `/api/v1/campaigns/${w.campaignId}/report`)).status).toBe(404);
      expect((await rest(w.t, noCampaigns.key)("POST", `/api/v1/sends/${(await w.sendTo("Ava"))._id}/replied`, {})).status).toBe(404);
    });

    it("previews an email for one person with who would get it and who is left out", async () => {
      const w = await world();
      await w.create(w.person, { name: "No Mail" }).then((id: any) => w.update(w.campaign, w.campaignId, { people: [...Object.values(w.people), id] }));
      const next = await w.draft({ subject: "Hey {{firstName}}", body: "Hi {{firstName|there}} from {{company}}" });
      const agent = await agentFor(w.client, w.orgId, { name: "reader" });
      const ben = (await w.read(w.people.Ben)).ref;
      const preview = await rest(w.t, agent.key)("GET", `/api/v1/emails/${(await w.read(next)).ref}/preview?person=${ben}`);
      expect(preview.status).toBe(200);
      expect(preview.json.rendered).toMatchObject({ subject: "Hey Ben", person: { name: "Ben Ortiz" } });
      expect(preview.json.rendered.text).toContain("Hi Ben from Acme Plumbing");
      expect(preview.json.rendered.text).toContain("1 Main St, Springfield");
      expect(preview.json.recipients.map((r: any) => r.address)).toEqual(["ava@people.test", "ben@people.test"]);
      expect(preview.json.excluded).toEqual([expect.objectContaining({ name: "No Mail", reason: "no email" })]);
      expect(preview.json.problems).toContain("Not approved yet");
    });

    it("an agent that can read the campaign marks a recipient replied, which keeps follow-ups from them", async () => {
      const w = await world();
      await tick(w.t);
      const agent = await agentFor(w.client, w.orgId, { name: "reader" });
      const ava = await w.sendTo("Ava");
      const marked = await rest(w.t, agent.key)("POST", `/api/v1/sends/${ava._id}/replied`, {});
      expect(marked.status).toBe(200);
      expect((await w.sendTo("Ava")).repliedAt).toBe(start);
      const next = await w.draft({ subject: "Again", body: "x", followsUp: w.first, waitDays: 0, sendTo: "everyone" });
      await w.approve(next);
      later(MINUTE);
      await tick(w.t);
      expect(delivered.slice(2).map(to)).toEqual(["ben@people.test"]);
    });
  });

  describe("settings", () => {
    it("only admins read and change them, and the checklist names what is missing without showing secrets", async () => {
      const w = await world();
      delete process.env.REMOLD_SENDER_DOMAINS;
      const view = await w.client.query(api.campaigns.settings, { orgId: w.orgId });
      expect(view.settings).toMatchObject({ fromName: "Owner Co", fromAddress: "hi@mail.example.com", postalAddress: "1 Main St, Springfield", dailyLimit: 50 });
      expect(Object.fromEntries(view.checklist.map((item: any) => [item.key, item.ok]))).toEqual({ apiKey: true, senderDomain: false, postalAddress: true, dailyLimit: true, deploymentCap: true, webhookSecret: true, inboundDomain: false });
      expect(view.checklist.find((item: any) => item.key === "inboundDomain").optional).toBe(true);
      expect(JSON.stringify(view)).not.toContain("re_test_key");
      expect(JSON.stringify(view)).not.toContain(env.RESEND_WEBHOOK_SECRET);
      await expect(w.save({ fromAddress: "not an address" })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
      await expect(w.save({ dailyLimit: 2.5 })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
      const { token } = await w.client.mutation(api.invites.create, { orgId: w.orgId, role: "member" });
      const member = w.t.withIdentity({ tokenIdentifier: "clerk|member", name: "Mo", email: "mo@example.com" });
      await member.mutation(api.users.store, {});
      await member.mutation(api.invites.accept, { token });
      await expect(member.query(api.campaigns.settings, { orgId: w.orgId })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
      await expect(member.mutation(api.campaigns.saveSettings, { orgId: w.orgId, dailyLimit: 1000 })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
      const draft = await w.draft({ subject: "Hi", body: "Hi" });
      await expect(member.mutation(api.campaigns.approve, { orgId: w.orgId, emailId: draft, confirmed: true })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    });
  });

  describe("one-off email for other features", () => {
    it("sends one email through the same gates and daily limits", async () => {
      const w = await world({ limit: 1 });
      const send = (subject: string) => w.t.action(internal.campaignSend.transactional, { orgId: w.orgId, to: "guest@people.test", subject, text: "Your call is booked." });
      expect(await send("Booked")).toMatchObject({ status: "sent" });
      expect(delivered[0]!.body).toMatchObject({ from: "Owner Co <hi@mail.example.com>", to: ["guest@people.test"], subject: "Booked" });
      expect(delivered[0]!.body.text).toContain("1 Main St, Springfield");
      expect(await send("Again")).toMatchObject({ status: "limited" });
      delete process.env.RESEND_API_KEY;
      later(DAY);
      expect(await send("No key")).toMatchObject({ status: "blocked" });
      expect(delivered).toHaveLength(1);
    });
  });
});
