import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { internal } from "./_generated/api";
import { agentFor, api, objectFields, rest } from "./test.helpers";
import { makeTest } from "./test.setup";
import { openSlots, parseHours } from "./lib/bookingTime";
import crons from "./crons";

// Booking pages: a public page per offer, open times from the page's hours and zone,
// optional payment through the owner's own Stripe Payment Link, and attribution back
// to the campaign email that brought the person. Resend and Stripe are faked here.
const MINUTE = 60_000;
const now0 = Date.UTC(2026, 9, 26, 12); // Monday 26 October 2026, 08:00 in New York (EDT)
const at = (y: number, m: number, d: number, h: number, mi = 0) => Date.UTC(y, m - 1, d, h, mi);
const STRIPE = "whsec_test_signing_secret_for_org_a", OTHER = "whsec_test_signing_secret_for_org_b";
const env = { REMOLD_BOOKING_DAILY_CAP: "50", REMOLD_APP_URL: "https://app.example.com", CONVEX_SITE_URL: "https://site.example.com" };
const mailEnv = { RESEND_API_KEY: "re_test_key", REMOLD_SENDER_DOMAINS: "mail.example.com", REMOLD_CAMPAIGN_DAILY_CAP: "100", RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from("resend-test").toString("base64")}` };
const ENV_KEYS = [...Object.keys(env), ...Object.keys(mailEnv)];

let sent: any[];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now0); Object.assign(process.env, env);
  sent = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any = {}) => { sent.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined }); return Response.json({ id: `re_${sent.length}` }); }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const key of ENV_KEYS) delete process.env[key]; });
const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
const settle = (t: any) => t.finishAllScheduledFunctions(vi.runAllTimers);

const HOURS = "mon-fri 09:00-12:00, 13:00-17:00";
async function world(options: { t?: any; name?: string } = {}) {
  const t = options.t ?? makeTest(), name = options.name ?? "Owner";
  const client = t.withIdentity({ tokenIdentifier: `clerk|${name}`, name, email: `${name.toLowerCase()}@example.com` });
  await client.mutation(api.users.store, {});
  const orgId = await client.mutation(api.orgs.create, { name: `${name} Co` });
  const [page, person, activity, campaign, email] = await Promise.all(["bookingPage", "person", "activity", "campaign", "email"].map((key) => objectFields(client, orgId, key)));
  const ids = (o: any, values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [o.fields[key]._id, value]));
  const create = async (o: any, values: Record<string, unknown>) => (await client.mutation(api.records.create, { orgId, objectId: o.object._id, values: ids(o, values) })).recordId;
  const update = (o: any, recordId: any, values: Record<string, unknown>) => client.mutation(api.records.update, { orgId, recordId, values: ids(o, values) });
  const newPage = (values: Record<string, unknown> = {}) => create(page, { name: "Intro call", description: "Fifteen minutes about your site.", minutes: 30, hours: HOURS, timezone: "America/New_York", noticeHours: 12, daysAhead: 30, live: true, ...values });
  const pageId = await newPage();
  const records = () => t.run((ctx: any) => ctx.db.query("records").collect());
  const bookings = () => t.run((ctx: any) => ctx.db.query("bookings").collect());
  const titlesAbout = async (personId: any) => (await records()).filter((r: any) => r.objectId === activity.object._id && r.values[activity.fields.about._id] === personId);
  const mail = (change: Record<string, unknown> = {}) => client.mutation(api.campaigns.saveSettings, { orgId, fromName: `${name} Co`, fromAddress: "hi@mail.example.com", postalAddress: "1 Main St", dailyLimit: 50, replyTo: "desk@example.com", ...change });
  return { t, client, orgId, page, person, activity, campaign, email, create, update, newPage, pageId, records, bookings, titlesAbout, mail };
}
const visitor = (t: any) => t; // no identity: a member of the public
const slotsOf = async (t: any, pageId: any) => (await visitor(t).query(api.bookings.page, { pageId })).slots as number[];
const book = (t: any, pageId: any, start: number, who: Record<string, unknown> = {}) => visitor(t).mutation(api.bookings.book, { pageId, start, name: "Ben Ortiz", email: "ben@people.test", zone: "America/Chicago", ...who });
const ny = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);

describe("open times", () => {
  it("follow the page's hours in its own zone, after the notice and within the horizon", async () => {
    const w = await world(), slots = await slotsOf(w.t, w.pageId);
    // 12 hours notice from Monday 08:00: the first time is Tuesday 09:00 New York.
    expect(slots[0]).toBe(at(2026, 10, 27, 13));
    for (const slot of slots) expect(ny(slot)).toMatch(/^(Mon|Tue|Wed|Thu|Fri) (09|10|11|13|14|15|16):(00|30)$/);
    expect(slots.filter((s) => s >= at(2026, 10, 27, 4) && s < at(2026, 10, 28, 4))).toHaveLength(14);
    // 30 days ahead ends Wednesday 25 November 07:00 New York, so the last time is the 24th at 16:30.
    expect(Math.max(...slots)).toBe(at(2026, 11, 24, 21, 30));
    await w.update(w.page, w.pageId, { noticeHours: 0 });
    expect((await slotsOf(w.t, w.pageId))[0]).toBe(at(2026, 10, 26, 13));
  });

  it("keep 09:00 local across the end of daylight saving time", async () => {
    const w = await world(), slots = await slotsOf(w.t, w.pageId);
    expect(slots).toContain(at(2026, 10, 30, 13)); // Friday 09:00 EDT
    expect(slots).toContain(at(2026, 11, 2, 14)); // Monday 09:00 EST
    expect(slots).not.toContain(at(2026, 11, 2, 13));
    // A local time that does not exist (02:30 on the spring change) is never offered.
    const spring = openSlots({ hours: parseHours("sun 02:00-03:00")!, timezone: "America/New_York", minutes: 30, noticeHours: 0, daysAhead: 14 }, at(2026, 3, 2, 12), []);
    expect(spring).toEqual([at(2026, 3, 15, 6), at(2026, 3, 15, 6, 30)]);
  });

  it("leave out confirmed bookings and live holds on any page in the workspace, and timed meetings", async () => {
    const w = await world(), other = await w.newPage({ name: "Second offer" }), elsewhere = await world({ t: w.t, name: "Stranger" });
    const nine = at(2026, 10, 27, 13), ten = at(2026, 10, 27, 14), eleven = at(2026, 10, 27, 15);
    expect(await book(w.t, w.pageId, nine)).toMatchObject({ status: "confirmed" });
    const paid = await w.newPage({ name: "Paid call", price: 5, paymentLink: "https://buy.stripe.com/test_123" });
    expect(await book(w.t, paid, ten, { email: "cy@people.test", name: "Cy" })).toMatchObject({ status: "held" });
    const person = await w.create(w.person, { name: "Dee" });
    await w.create(w.activity, { title: "Site visit", type: "meeting", when: at(2026, 10, 27, 15, 10), about: person });
    await w.create(w.activity, { title: "Phone chat", type: "call", when: at(2026, 10, 27, 17), about: person });
    for (const id of [w.pageId, other]) {
      const slots = await slotsOf(w.t, id);
      expect(slots).not.toContain(nine); expect(slots).not.toContain(ten);
      // A meeting at 11:10 is taken to last the page's 30 minutes, so 11:00 and 11:30 are gone.
      expect(slots).not.toContain(eleven); expect(slots).not.toContain(eleven + 30 * MINUTE);
      expect(slots).toContain(at(2026, 10, 27, 17));
      expect(slots).toContain(nine + 30 * MINUTE);
    }
    const strangerSlots = await slotsOf(w.t, elsewhere.pageId);
    expect(strangerSlots).toContain(nine); expect(strangerSlots).toContain(eleven);
  });

  it("a payment hold frees its time after 30 minutes, and the cron marks it expired", async () => {
    const w = await world(), paid = await w.newPage({ price: 5, paymentLink: "https://buy.stripe.com/test_123" }), slot = at(2026, 10, 27, 14);
    const held = await book(w.t, paid, slot);
    expect(held.status).toBe("held");
    const token = (await w.bookings())[0].token;
    expect(held.pay).toBe(`https://buy.stripe.com/test_123?client_reference_id=${token}&prefilled_email=ben%40people.test`);
    later(29 * MINUTE); expect(await slotsOf(w.t, w.pageId)).not.toContain(slot);
    later(2 * MINUTE); expect(await slotsOf(w.t, w.pageId)).toContain(slot);
    await w.t.mutation(internal.bookings.expire, {});
    expect((await w.bookings())[0]).toMatchObject({ status: "cancelled", cancelReason: "expired" });
    expect(Object.values((crons as any).crons)).toContainEqual(expect.objectContaining({ name: "bookings:expire", schedule: { type: "cron", cron: "* * * * *" } }));
  });
});

describe("booking", () => {
  it("two people racing for one time: exactly one gets it", async () => {
    const w = await world(), slot = at(2026, 10, 28, 15);
    const results = await Promise.all([book(w.t, w.pageId, slot), book(w.t, w.pageId, slot, { email: "ann@people.test", name: "Ann" }), book(w.t, w.pageId, slot, { email: "cy@people.test", name: "Cy" })]);
    expect(results.map((r: any) => r.status).sort()).toEqual(["confirmed", "taken", "taken"]);
    expect((await w.bookings()).filter((b: any) => b.start === slot)).toHaveLength(1);
  });

  it("refuses a time that is not open", async () => {
    const w = await world();
    for (const start of [at(2026, 10, 26, 13), at(2026, 10, 31, 14), at(2026, 10, 27, 13, 15), at(2026, 12, 20, 14)]) expect(await book(w.t, w.pageId, start)).toEqual({ status: "taken" });
    expect(await w.bookings()).toHaveLength(0);
  });

  it("a page that is not live, deleted, in a read-only workspace, or without a daily cap takes no bookings", async () => {
    const slot = at(2026, 10, 28, 15), closed = { open: false, message: "This page is not taking bookings." };
    const checks: [string, (w: any) => Promise<unknown>][] = [
      ["not live", (w) => w.update(w.page, w.pageId, { live: false })],
      ["deleted", (w) => w.client.mutation(api.records.remove, { orgId: w.orgId, recordId: w.pageId })],
      ["read only", (w) => w.t.run((ctx: any) => ctx.db.patch(w.orgId, { flags: { readonly: true } }))],
      ["no cap", async () => { delete process.env.REMOLD_BOOKING_DAILY_CAP; }],
      ["zero cap", async () => { process.env.REMOLD_BOOKING_DAILY_CAP = "0"; }],
      ["bad cap", async () => { process.env.REMOLD_BOOKING_DAILY_CAP = "1e3"; }],
    ];
    for (const [why, close] of checks) {
      process.env.REMOLD_BOOKING_DAILY_CAP = "50";
      const w = await world();
      expect((await slotsOf(w.t, w.pageId)).length, why).toBeGreaterThan(0);
      await close(w);
      expect(await visitor(w.t).query(api.bookings.page, { pageId: w.pageId }), why).toEqual(closed);
      expect(await book(w.t, w.pageId, slot), why).toEqual({ status: "closed" });
      expect(await w.bookings(), why).toHaveLength(0);
    }
  });

  it("stops at the workspace's daily cap", async () => {
    process.env.REMOLD_BOOKING_DAILY_CAP = "2";
    const w = await world();
    expect(await book(w.t, w.pageId, at(2026, 10, 28, 13), { email: "a@people.test" })).toMatchObject({ status: "confirmed" });
    expect(await book(w.t, w.pageId, at(2026, 10, 28, 14), { email: "b@people.test" })).toMatchObject({ status: "confirmed" });
    expect(await book(w.t, w.pageId, at(2026, 10, 28, 15), { email: "c@people.test" })).toMatchObject({ status: "limited" });
    expect(await w.bookings()).toHaveLength(2);
  });

  it("links an existing person by email without changing them, and creates a new one otherwise", async () => {
    const w = await world();
    const ava = await w.create(w.person, { name: "Ava Stone", email: "Ava@People.test", phone: "+1 555 0100" });
    const before = await w.t.run((ctx: any) => ctx.db.get(ava));
    expect(await book(w.t, w.pageId, at(2026, 10, 28, 13), { name: "Someone Else", email: " ava@people.TEST ", note: "Call my cell" })).toMatchObject({ status: "confirmed" });
    expect(await w.t.run((ctx: any) => ctx.db.get(ava))).toEqual(before);
    await book(w.t, w.pageId, at(2026, 10, 28, 14), { name: "New Person", email: "new@people.test" });
    const [first, second] = await w.bookings();
    expect(first).toMatchObject({ personRecordId: ava, name: "Someone Else", email: "ava@people.test", note: "Call my cell", status: "confirmed" });
    const created = await w.t.run((ctx: any) => ctx.db.get(second.personRecordId));
    expect(created).toMatchObject({ title: "New Person", values: { [w.person.fields.email._id]: "new@people.test" } });
  });

  it("a filled honeypot looks like success and writes nothing", async () => {
    const w = await world(), before = await w.records();
    expect(await book(w.t, w.pageId, at(2026, 10, 28, 13), { website: "http://spam.example" })).toEqual({ status: "confirmed" });
    expect(await w.bookings()).toHaveLength(0);
    expect(await w.records()).toEqual(before);
  });

  it("a confirmed booking lands on the person's timeline and emails the booker and the owner", async () => {
    Object.assign(process.env, mailEnv);
    const w = await world(); await w.mail();
    const slot = at(2026, 10, 28, 13);
    await book(w.t, w.pageId, slot, { note: "About my plumbing site" });
    await settle(w.t);
    const [booking] = await w.bookings();
    const [meeting] = await w.titlesAbout(booking.personRecordId);
    expect(meeting).toMatchObject({ title: "Intro call with Ben Ortiz", values: { [w.activity.fields.type._id]: "meeting", [w.activity.fields.when._id]: slot, [w.activity.fields.source._id]: "booking" } });
    const emails = sent.filter((c) => c.url === "https://api.resend.com/emails");
    expect(emails.map((c) => c.body.to[0]).sort()).toEqual(["ben@people.test", "desk@example.com"]);
    const toBooker = emails.find((c) => c.body.to[0] === "ben@people.test").body;
    // The booker chose Chicago: 09:00 New York is 08:00 there.
    expect(toBooker.text).toContain("8:00 AM CDT");
    expect(toBooker.text).toContain("https://calendar.google.com/calendar/render?action=TEMPLATE");
    expect(toBooker.text).toContain("dates=20261028T130000Z%2F20261028T133000Z");
    const toOwner = emails.find((c) => c.body.to[0] === "desk@example.com").body;
    expect(toOwner.text).toContain("About my plumbing site");
    expect(toOwner.text).toContain("ben@people.test");
  });

  it("succeeds without email set up; only the owner is told on the page", async () => {
    const w = await world();
    expect(await book(w.t, w.pageId, at(2026, 10, 28, 13))).toMatchObject({ status: "confirmed" });
    await settle(w.t);
    expect(sent).toHaveLength(0);
    expect((await w.bookings())[0].status).toBe("confirmed");
    expect((await w.client.query(api.bookings.page, { pageId: w.pageId })).notice).toMatch(/email/i);
    expect(await visitor(w.t).query(api.bookings.page, { pageId: w.pageId })).not.toHaveProperty("notice");
  });

  it("the public page shows only what the visitor needs", async () => {
    const w = await world(), campaignId = await w.create(w.campaign, { name: "Secret campaign" });
    const paid = await w.newPage({ price: 5, paymentLink: "https://buy.stripe.com/test_secretlink", campaign: campaignId });
    const shown = await visitor(w.t).query(api.bookings.page, { pageId: paid });
    expect(Object.keys(shown).sort()).toEqual(["description", "minutes", "name", "open", "paid", "price", "slots"]);
    expect(shown).toMatchObject({ open: true, name: "Intro call", description: "Fifteen minutes about your site.", minutes: 30, price: 5, paid: true });
    const text = JSON.stringify(shown);
    for (const secret of ["test_secretlink", campaignId, w.orgId, "America/New_York", "mon-fri"]) expect(text).not.toContain(secret);
    // Any other record id, or garbage, is just a closed page.
    const person = await w.create(w.person, { name: "Not a page" });
    for (const pageId of [person, campaignId, "nonsense"]) expect(await visitor(w.t).query(api.bookings.page, { pageId })).toEqual({ open: false, message: "This page is not taking bookings." });
    expect(await book(w.t, person, at(2026, 10, 28, 13))).toEqual({ status: "closed" });
  });
});

describe("page records", () => {
  it("check hours, zone, length and payment link", async () => {
    const w = await world();
    const refused = async (values: Record<string, unknown>) => expect(w.newPage(values)).rejects.toThrow(/VALIDATION|hours|zone|Stripe|minutes/i);
    await refused({ hours: "weekdays 9 to 5" });
    await refused({ hours: "mon 12:00-09:00" });
    await refused({ timezone: "Mars/Base" });
    await refused({ paymentLink: "https://evil.example/pay" });
    await refused({ paymentLink: "http://buy.stripe.com/x" });
    await refused({ minutes: 0 });
    await w.newPage({ hours: "mon,wed 10:00-11:00; sat 10:00-14:00", paymentLink: "https://checkout.stripe.com/c/pay/cs_test" });
    expect(parseHours("mon-fri 09:00-12:00, 13:00-17:00; sat 10:00-14:00")).toEqual({ 1: [[540, 720], [780, 1020]], 2: [[540, 720], [780, 1020]], 3: [[540, 720], [780, 1020]], 4: [[540, 720], [780, 1020]], 5: [[540, 720], [780, 1020]], 6: [[600, 840]] });
  });

  it("agents draft and edit pages and may take one down, but only a person publishes", async () => {
    const w = await world();
    const agent = await agentFor(w.client, w.orgId, { name: "pager", grants: ["create", "update"].map((action: any) => ({ action, objectKey: "bookingPage" })) });
    const call = rest(w.t, agent.key), change = (body: Record<string, unknown>) => call("POST", "/api/v1/changes", { reason: "test", ...body });
    const drafted = await change({ action: "create", object: "bookingPage", values: { name: "Agent page", hours: "mon 09:00-10:00", timezone: "Europe/London", live: false } });
    expect(drafted.status).toBe(200);
    const id = drafted.json.record.id;
    expect((await change({ action: "update", record: id, values: { description: "Better words" } })).status).toBe(200);
    const refused = await change({ action: "update", record: id, values: { live: true } });
    expect(refused.status).toBe(403);
    expect(refused.json.error.message).toMatch(/person/i);
    expect((await call("POST", "/api/v1/suggestions", { action: "update", record: id, values: { live: true }, reason: "x" })).status).toBe(403);
    expect((await change({ action: "create", object: "bookingPage", values: { name: "Sneaky", live: true } })).status).toBe(403);
    await w.update(w.page, id, { live: true });
    expect((await change({ action: "update", record: id, values: { live: false } })).status).toBe(200);
  });

  it("new workspaces get Booking pages, and the migration adds them to an older workspace once", async () => {
    const t = makeTest(), w = await world({ t });
    expect(Object.keys(w.page.fields)).toEqual(["name", "description", "minutes", "hours", "timezone", "noticeHours", "daysAhead", "price", "paymentLink", "campaign", "live"]);
    expect(w.page.object).toMatchObject({ label: "Booking page", labelPlural: "Booking pages", titleFieldId: w.page.fields.name._id });
    for (const key of ["description", "paymentLink"]) expect(w.page.fields[key].slot).toBeUndefined();
    expect(w.page.fields.campaign).toMatchObject({ type: "lookup", targetObjectId: w.campaign.object._id });
    const snapshot = () => t.run(async (ctx: any) => ({ objects: await ctx.db.query("objects").collect(), fields: await ctx.db.query("fields").collect() }));
    await t.run(async (ctx: any) => {
      for (const record of await ctx.db.query("records").collect()) if (record.objectId === w.page.object._id) await ctx.db.delete(record._id);
      for (const field of await ctx.db.query("fields").collect()) if (field.objectId === w.page.object._id) await ctx.db.delete(field._id);
      await ctx.db.delete(w.page.object._id);
    });
    const old = await snapshot();
    await t.mutation(internal.seed.ensureStandard, { orgId: w.orgId });
    const once = await snapshot();
    const added = once.objects.find((o: any) => o.orgId === w.orgId && o.key === "bookingPage");
    expect(added).toMatchObject({ isStandard: true, labelPlural: "Booking pages" });
    expect(once.fields.filter((f: any) => f.objectId === added._id)).toHaveLength(11);
    for (const before of old.fields) expect(once.fields.find((f: any) => f._id === before._id)).toEqual(before);
    await t.mutation(internal.seed.ensureStandard, { orgId: w.orgId });
    expect(await snapshot()).toEqual(once);
  });
});

const signStripe = (secret: string, body: string, ts = Math.floor(Date.now() / 1000)) => `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
const paidEvent = (ref: string, extra: Record<string, unknown> = {}, id = "evt_1") => ({ id, type: "checkout.session.completed", data: { object: { id: "cs_test_1", object: "checkout.session", client_reference_id: ref, payment_status: "paid", amount_total: 500, currency: "usd", ...extra } } });
async function stripeHook(t: any, orgId: any, event: unknown, options: { secret?: string; ts?: number; signature?: string } = {}) {
  const body = JSON.stringify(event);
  const response = await t.fetch(`/webhooks/stripe/${orgId}`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": options.signature ?? signStripe(options.secret ?? STRIPE, body, options.ts) }, body });
  return response.status;
}

describe("payments", () => {
  async function paidWorld() {
    const w = await world(), paid = await w.newPage({ name: "Paid call", price: 5, paymentLink: "https://buy.stripe.com/test_123" });
    await w.client.mutation(api.bookings.savePaymentSecret, { orgId: w.orgId, secret: STRIPE });
    const slot = at(2026, 10, 28, 13);
    await book(w.t, paid, slot);
    const token = (await w.bookings())[0].token;
    const everything = () => w.t.run(async (ctx: any) => ({ bookings: await ctx.db.query("bookings").collect(), records: await ctx.db.query("records").collect(), events: await ctx.db.query("events").collect(), inbox: await ctx.db.query("agentInbox").collect() }));
    return { ...w, paid, slot, token, everything };
  }

  it("the signing secret is write-only and the card shows the webhook address", async () => {
    const w = await world();
    expect(await w.client.query(api.bookings.paymentSettings, { orgId: w.orgId })).toEqual({ webhookUrl: `https://site.example.com/webhooks/stripe/${w.orgId}`, secretSet: false });
    await expect(w.client.mutation(api.bookings.savePaymentSecret, { orgId: w.orgId, secret: "not-a-secret" })).rejects.toThrow(/whsec_/);
    await w.client.mutation(api.bookings.savePaymentSecret, { orgId: w.orgId, secret: ` ${STRIPE} ` });
    const shown = await w.client.query(api.bookings.paymentSettings, { orgId: w.orgId });
    expect(shown).toEqual({ webhookUrl: `https://site.example.com/webhooks/stripe/${w.orgId}`, secretSet: true });
    const member = w.t.withIdentity({ tokenIdentifier: "clerk|Mia", name: "Mia" });
    await member.mutation(api.users.store, {});
    const invite = await w.client.mutation(api.invites.create, { orgId: w.orgId, role: "member" });
    await member.mutation(api.invites.accept, { token: invite.token });
    await expect(member.query(api.bookings.paymentSettings, { orgId: w.orgId })).rejects.toThrow();
    await expect(member.mutation(api.bookings.savePaymentSecret, { orgId: w.orgId, secret: OTHER })).rejects.toThrow();
  });

  it("a webhook with no secret, a bad signature, a stale time or another workspace's secret writes nothing", async () => {
    const w = await paidWorld(), stranger = await world({ t: w.t, name: "Stranger" });
    await stranger.client.mutation(api.bookings.savePaymentSecret, { orgId: stranger.orgId, secret: OTHER });
    const lonely = await world({ t: w.t, name: "Lonely" });
    const before = await w.everything();
    expect(await stripeHook(w.t, lonely.orgId, paidEvent(w.token))).toBe(503);
    expect(await stripeHook(w.t, w.orgId, paidEvent(w.token), { signature: "t=1,v1=00" })).toBe(400);
    expect(await stripeHook(w.t, w.orgId, paidEvent(w.token), { signature: "" })).toBe(400);
    expect(await stripeHook(w.t, w.orgId, paidEvent(w.token), { ts: Math.floor(Date.now() / 1000) - 301 })).toBe(400);
    expect(await stripeHook(w.t, w.orgId, paidEvent(w.token), { secret: OTHER })).toBe(400);
    // Signed by the stranger for their own endpoint: a valid event there, but the booking is not theirs.
    expect(await stripeHook(w.t, stranger.orgId, paidEvent(w.token), { secret: OTHER })).toBe(200);
    expect(await stripeHook(w.t, w.orgId, paidEvent("0123456789abcdef0123456789abcdef", {}, "evt_unknown"))).toBe(200);
    expect(await stripeHook(w.t, w.orgId, paidEvent(w.token, { payment_status: "unpaid" }, "evt_unpaid"))).toBe(200);
    expect(await w.everything()).toEqual(before);
    expect((await w.bookings())[0]).toMatchObject({ status: "held" });
  });

  it("a paid event confirms the booking once, with the amount from the event, even when delivered twice", async () => {
    const w = await paidWorld(), event = paidEvent(w.token);
    expect(await stripeHook(w.t, w.orgId, event)).toBe(200);
    expect(await stripeHook(w.t, w.orgId, event)).toBe(200);
    expect(await stripeHook(w.t, w.orgId, { ...event, id: "evt_retry_other_id" })).toBe(200);
    const [booking] = await w.bookings();
    expect(booking).toMatchObject({ status: "confirmed", amountMinor: 500, currency: "usd", stripeSessionId: "cs_test_1" });
    expect(booking.paidAt).toBe(Date.now());
    const titles = (await w.titlesAbout(booking.personRecordId)).map((r: any) => r.title).sort();
    expect(titles).toEqual(["Paid $5.00 for Paid call", "Paid call with Ben Ortiz"]);
    expect(await slotsOf(w.t, w.pageId)).not.toContain(w.slot);
  });

  it("paid after the hold ran out and the time was taken: stays paid and asks the owner", async () => {
    const w = await paidWorld();
    later(31 * MINUTE);
    await w.t.mutation(internal.bookings.expire, {});
    expect(await book(w.t, w.pageId, w.slot, { email: "zed@people.test", name: "Zed" })).toMatchObject({ status: "confirmed" });
    expect(await stripeHook(w.t, w.orgId, paidEvent(w.token))).toBe(200);
    const late = (await w.bookings()).find((b: any) => b.token === w.token);
    expect(late.status).not.toBe("confirmed");
    expect(late).toMatchObject({ amountMinor: 500, currency: "usd" });
    expect(late.paidAt).toBeTypeOf("number");
    expect(late.attention).toMatch(/taken/i);
    const inbox = await w.t.run((ctx: any) => ctx.db.query("agentInbox").collect());
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ orgId: w.orgId, status: "pending", source: "booking" });
    expect(inbox[0].text).toMatch(/rebook or refund/i);
    expect((await w.client.query(api.inbox.list, { orgId: w.orgId })).map((i: any) => i._id)).toContain(inbox[0]._id);
  });

  it("paid after the hold ran out with the time still free: confirmed", async () => {
    const w = await paidWorld();
    later(45 * MINUTE);
    await w.t.mutation(internal.bookings.expire, {});
    expect(await stripeHook(w.t, w.orgId, paidEvent(w.token))).toBe(200);
    expect((await w.bookings())[0]).toMatchObject({ status: "confirmed", amountMinor: 500 });
  });
});

describe("owner and agents", () => {
  it("the owner lists a page's bookings upcoming first and cancels one, which frees the time", async () => {
    Object.assign(process.env, mailEnv);
    const w = await world(); await w.mail();
    await book(w.t, w.pageId, at(2026, 10, 29, 13), { email: "late@people.test", name: "Later" });
    await book(w.t, w.pageId, at(2026, 10, 28, 13), { email: "soon@people.test", name: "Sooner" });
    await settle(w.t); sent = [];
    const listed = await w.client.query(api.bookings.forPage, { orgId: w.orgId, pageId: w.pageId });
    expect(listed.map((b: any) => b.name)).toEqual(["Sooner", "Later"]);
    await w.client.mutation(api.bookings.cancel, { orgId: w.orgId, bookingId: listed[0].id, notify: true });
    await settle(w.t);
    expect(await slotsOf(w.t, w.pageId)).toContain(at(2026, 10, 28, 13));
    const cancelled = (await w.bookings()).find((b: any) => b.name === "Sooner");
    expect(cancelled.status).toBe("cancelled");
    expect((await w.titlesAbout(cancelled.personRecordId)).map((r: any) => r.title)).toContain("Cancelled: Intro call with Sooner");
    expect(sent.map((c) => c.body.to[0])).toEqual(["soon@people.test"]);
    expect(sent[0].body.subject).toMatch(/cancelled/i);
  });

  it("agents list bookings over REST, by page and time, and see people only as far as they may", async () => {
    const w = await world(), second = await w.newPage({ name: "Second" });
    await book(w.t, w.pageId, at(2026, 10, 28, 13));
    await book(w.t, second, at(2026, 11, 3, 15), { email: "cy@people.test", name: "Cy" });
    const agent = await agentFor(w.client, w.orgId, { name: "reader" });
    const call = rest(w.t, agent.key);
    const all = await call("GET", "/api/v1/bookings");
    expect(all.status).toBe(200);
    expect(all.json.bookings.map((b: any) => b.name)).toEqual(["Ben Ortiz", "Cy"]);
    expect(all.json.bookings[0]).toMatchObject({ page: { id: w.pageId }, status: "confirmed", start: new Date(at(2026, 10, 28, 13)).toISOString(), email: "ben@people.test", paid: false });
    expect((await call("GET", `/api/v1/bookings?page=${second}`)).json.bookings.map((b: any) => b.name)).toEqual(["Cy"]);
    expect((await call("GET", "/api/v1/bookings?from=2026-11-01&to=2026-11-30")).json.bookings.map((b: any) => b.name)).toEqual(["Cy"]);
    const pageOnly = await agentFor(w.client, w.orgId, { name: "narrow" });
    await w.t.run((ctx: any) => ctx.db.patch(pageOnly.agentId, { readObjectIds: [w.page.object._id] }));
    const narrow = await rest(w.t, pageOnly.key)("GET", "/api/v1/bookings");
    expect(narrow.status).toBe(200);
    expect(narrow.json.bookings[0]).toMatchObject({ name: null, email: null, person: null });
  });
});

const approve = async (w: any, emailId: any) => { const { version } = await w.client.query(api.campaigns.preview, { orgId: w.orgId, emailId }); return w.client.mutation(api.campaigns.approve, { orgId: w.orgId, emailId, confirmed: true, version: version ?? "" }); };
describe("attribution", () => {
  async function campaignWorld(body = "Grab a time: {{bookingLink}}") {
    Object.assign(process.env, mailEnv);
    const w = await world(); await w.mail();
    const ava = await w.create(w.person, { name: "Ava Stone", email: "ava@people.test" });
    const campaignId = await w.create(w.campaign, { name: "Five dollar calls", status: "active", channel: "email", people: [ava] });
    const paid = await w.newPage({ name: "Five dollar call", price: 5, paymentLink: "https://buy.stripe.com/test_5", campaign: campaignId });
    const emailId = await w.create(w.email, { subject: "Quick call?", body, campaign: campaignId, status: "draft" });
    return { ...w, ava, campaignId, paid, emailId };
  }

  it("{{bookingLink}} carries the send, and the booking and payment show up in the campaign report", async () => {
    const w = await campaignWorld();
    await approve(w, w.emailId);
    await w.t.action(internal.campaignSend.tick, {});
    const send = (await w.t.run((ctx: any) => ctx.db.query("emailSends").collect()))[0];
    const mailed = sent.find((c) => c.url === "https://api.resend.com/emails").body;
    const link = `https://app.example.com/book/${w.paid}?s=${send.token}`;
    expect(mailed.text).toContain(link);
    expect(await book(w.t, w.paid, at(2026, 10, 28, 13), { name: "Ava", email: "ava@people.test", s: send.token })).toMatchObject({ status: "held" });
    const [booking] = await w.bookings();
    expect(booking).toMatchObject({ sendId: send._id, campaignRecordId: w.campaignId, personRecordId: w.ava });
    await w.client.mutation(api.bookings.savePaymentSecret, { orgId: w.orgId, secret: STRIPE });
    expect(await stripeHook(w.t, w.orgId, paidEvent(booking.token))).toBe(200);
    const agent = await agentFor(w.client, w.orgId, { name: "reporter" });
    const report = (await rest(w.t, agent.key)("GET", `/api/v1/campaigns/${w.campaignId}/report`)).json;
    expect(report.bookings).toEqual({ booked: 1, paid: 1, revenue: [{ currency: "usd", amountMinor: 500 }] });
    expect(report.emails[0].recipients[0]).toMatchObject({ booked: true, paid: true });
    const app = await w.client.query(api.campaigns.report, { orgId: w.orgId, campaignId: w.campaignId });
    expect(app.bookings).toEqual(report.bookings);
  });

  it("{{bookingLink:<ref>}} picks one of several pages; a link with no page refuses approval", async () => {
    const w = await campaignWorld();
    const second = await w.newPage({ name: "Free chat", campaign: w.campaignId }), ref = (await w.t.run((ctx: any) => ctx.db.get(second))).ref;
    await w.update(w.email, w.emailId, { body: `Paid: {{bookingLink}} Free: {{bookingLink:${ref}}}` });
    await approve(w, w.emailId);
    await w.t.action(internal.campaignSend.tick, {});
    const token = (await w.t.run((ctx: any) => ctx.db.query("emailSends").collect()))[0].token;
    expect(sent.find((c) => c.url === "https://api.resend.com/emails").body.text).toContain(`Paid: https://app.example.com/book/${w.paid}?s=${token} Free: https://app.example.com/book/${second}?s=${token}`);
    const lonely = await w.create(w.campaign, { name: "No pages", status: "active" });
    const draft = await w.create(w.email, { subject: "Hi", body: "Book: {{bookingLink}}", campaign: lonely, status: "draft" });
    await expect(approve(w, draft)).rejects.toThrow(/booking page/i);
    const wrongRef = await w.create(w.email, { subject: "Hi", body: "Book: {{bookingLink:no-such-page}}", campaign: w.campaignId, status: "draft" });
    await expect(approve(w, wrongRef)).rejects.toThrow(/booking page/i);
  });
});
