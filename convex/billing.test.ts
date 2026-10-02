import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, userAndOrg } from "./test.helpers";

const secret = "whsec_test_only_not_a_real_secret";
const testEnv = { REMOLD_BILLING: "test", STRIPE_SECRET_KEY: "sk_test_stub", STRIPE_WEBHOOK_SECRET: secret, REMOLD_PRICE_ID: "price_from_env", REMOLD_APP_URL: "https://app.example.invalid" };
const env = (values: Record<string, string>) => { for (const [k, v] of Object.entries(values)) vi.stubEnv(k, v); };
const signed = (body: string, at = Math.floor(Date.now() / 1000), key = secret) => `t=${at},v1=${createHmac("sha256", key).update(`${at}.${body}`).digest("hex")}`;
const deliver = (t: any, event: unknown, signature?: (body: string) => string) => {
  const body = JSON.stringify(event);
  return t.fetch("/billing/stripe", { method: "POST", headers: { "content-type": "application/json", ...(signature ? { "stripe-signature": signature(body) } : {}) }, body });
};
const subscription = (orgId: string, status: string, created: number, type = "customer.subscription.updated") => ({ id: `evt_${created}`, type, created, livemode: false, data: { object: { id: "sub_1", customer: "cus_1", status, metadata: { orgId } } } });

// What Stripe sends for a paid subscription Checkout opened by billing.checkout.
const paidSession = (orgId: string, subscription: string) => ({ mode: "subscription", payment_status: "paid", client_reference_id: orgId, customer: "cus_1", subscription, metadata: { orgId, price: "price_from_env" } });

let stripe: ReturnType<typeof vi.fn>;
beforeEach(() => {
  stripe = vi.fn(async () => new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" }), { status: 200 }));
  vi.stubGlobal("fetch", stripe);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("subscription billing (Stripe test mode only)", () => {
  it("stays off unless REMOLD_BILLING=test with test keys", async () => {
    const a = await userAndOrg("A");
    expect(await a.client.query(api.billing.status, { orgId: a.orgId })).toEqual({ enabled: false, status: null });
    await expect(a.client.action(api.billing.checkout, { orgId: a.orgId })).rejects.toMatchObject({ data: { code: "UNSUPPORTED" } });
    expect((await deliver(a.t, subscription(a.orgId, "active", 1), signed)).status).toBe(404);
    env({ ...testEnv, REMOLD_BILLING: "live" });
    expect((await a.client.query(api.billing.status, { orgId: a.orgId })).enabled).toBe(false);
    expect(stripe).not.toHaveBeenCalled();
  });

  it("refuses a live Stripe key even with billing switched to test", async () => {
    const a = await userAndOrg("A");
    env({ ...testEnv, STRIPE_SECRET_KEY: "sk_live_should_never_be_used" });
    await expect(a.client.action(api.billing.checkout, { orgId: a.orgId })).rejects.toMatchObject({ data: { code: "UNSUPPORTED", message: expect.stringMatching(/live/i) } });
    expect((await a.client.query(api.billing.status, { orgId: a.orgId })).enabled).toBe(false);
    env({ STRIPE_SECRET_KEY: "rk_live_restricted" });
    await expect(a.client.action(api.billing.checkout, { orgId: a.orgId })).rejects.toMatchObject({ data: { code: "UNSUPPORTED" } });
    expect(stripe).not.toHaveBeenCalled();
  });

  it("opens a subscription Checkout for the owner with the price from the environment", async () => {
    const a = await userAndOrg("A");
    env(testEnv);
    expect(await a.client.action(api.billing.checkout, { orgId: a.orgId })).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    const [url, init] = stripe.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk_test_stub");
    const form = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(form)).toMatchObject({ mode: "subscription", "line_items[0][price]": "price_from_env", "line_items[0][quantity]": "1", client_reference_id: a.orgId, "subscription_data[metadata][orgId]": a.orgId, "metadata[price]": "price_from_env", success_url: expect.stringContaining(`https://app.example.invalid/o/${a.orgId}/settings`) });
    const b = a.t.withIdentity({ tokenIdentifier: "clerk|B", name: "B" });
    await b.mutation(api.users.store, {});
    const invite = await a.client.mutation(api.invites.create, { orgId: a.orgId, role: "admin" });
    await b.mutation(api.invites.accept, { token: invite.token });
    await expect(b.action(api.billing.checkout, { orgId: a.orgId })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    expect(stripe).toHaveBeenCalledTimes(1);
  });

  it("sets the workspace access flag only from correctly signed, fresh webhook events", async () => {
    const a = await userAndOrg("A");
    const b = a.t.withIdentity({ tokenIdentifier: "clerk|B", name: "B" });
    await b.mutation(api.users.store, {});
    const orgB = await b.mutation(api.orgs.create, { name: "B Org" });
    env(testEnv);
    const now = Math.floor(Date.now() / 1000);
    const status = async () => (await a.client.query(api.billing.status, { orgId: a.orgId })).status;
    expect((await deliver(a.t, subscription(a.orgId, "active", now))).status).toBe(400);
    expect((await deliver(a.t, subscription(a.orgId, "active", now), (body) => signed(body, now, "whsec_wrong"))).status).toBe(400);
    expect((await deliver(a.t, subscription(a.orgId, "active", now), (body) => signed(body + " ", now))).status).toBe(400);
    expect((await deliver(a.t, subscription(a.orgId, "active", now), (body) => signed(body, now - 3600))).status).toBe(400);
    expect((await deliver(a.t, { ...subscription(a.orgId, "active", now), livemode: true }, signed)).status).toBe(400);
    expect(await status()).toBeNull();
    const completed = { id: "evt_c", type: "checkout.session.completed", created: now, livemode: false, data: { object: paidSession(a.orgId, "sub_1") } };
    expect((await deliver(a.t, completed, signed)).status).toBe(200);
    expect(await status()).toBe("active");
    expect((await deliver(a.t, subscription(a.orgId, "past_due", now + 10), signed)).status).toBe(200);
    expect(await status()).toBe("past_due");
    // An older event arriving late does not undo a newer one.
    expect((await deliver(a.t, subscription(a.orgId, "active", now + 5), signed)).status).toBe(200);
    expect(await status()).toBe("past_due");
    expect((await deliver(a.t, subscription(a.orgId, "canceled", now + 20, "customer.subscription.deleted"), signed)).status).toBe(200);
    expect(await status()).toBe("canceled");
    expect((await b.query(api.billing.status, { orgId: orgB })).status).toBeNull();
    expect((await deliver(a.t, { id: "evt_x", type: "invoice.created", created: now, livemode: false, data: { object: {} } }, signed)).status).toBe(200);
  });

  it("ignores redelivered and replayed events and records each flag change as an attributed billing event", async () => {
    const a = await userAndOrg("A");
    env(testEnv);
    const now = Math.floor(Date.now() / 1000);
    const event = (id: string, type: string, sub: string, status: string, created = now) => ({ id, type, created, livemode: false, data: { object: type === "checkout.session.completed" ? paidSession(a.orgId, sub) : { id: sub, customer: "cus_1", status, metadata: { orgId: a.orgId } } } });
    const status = async () => (await a.client.query(api.billing.status, { orgId: a.orgId })).status;
    const log = () => a.t.run(async (ctx: any) => (await ctx.db.query("billingEvents").collect()).map((e: any) => [e.eventId, e.from ?? null, e.to ?? null]));
    // Same second: active, then canceled, then a replay of the first. Order is (created, event id).
    for (const e of [event("evt_a", "checkout.session.completed", "sub_1", "active"), event("evt_b", "customer.subscription.deleted", "sub_1", "canceled"), event("evt_a", "checkout.session.completed", "sub_1", "active")]) expect((await deliver(a.t, e, signed)).status).toBe(200);
    expect(await status()).toBe("canceled");
    expect(await log()).toEqual([["evt_a", "none", "active"], ["evt_b", "active", "canceled"]]);
    // A new subscription takes over through Checkout; a late event about the old one changes nothing.
    await deliver(a.t, event("evt_c", "checkout.session.completed", "sub_2", "active", now + 60), signed);
    await deliver(a.t, event("evt_d", "customer.subscription.updated", "sub_1", "past_due", now + 120), signed);
    expect(await status()).toBe("active");
    expect((await log()).slice(2)).toEqual([["evt_c", "canceled", "active"], ["evt_d", null, null]]);
    // Same second, delivered out of order: the higher event id decides, whatever arrives last.
    await deliver(a.t, event("evt_h", "customer.subscription.updated", "sub_2", "past_due", now + 200), signed);
    await deliver(a.t, event("evt_g", "customer.subscription.updated", "sub_2", "active", now + 200), signed);
    expect(await status()).toBe("past_due");
  });

  it("activates only from a paid subscription Checkout for the configured price, and ignores a workspace being deleted", async () => {
    const a = await userAndOrg("A");
    env(testEnv);
    const now = Math.floor(Date.now() / 1000);
    const status = async () => (await a.client.query(api.billing.status, { orgId: a.orgId })).status;
    const session = (id: string, change: object) => ({ id, type: "checkout.session.completed", created: now, livemode: false, data: { object: { ...paidSession(a.orgId, "sub_1"), ...change } } });
    for (const [id, change] of [["evt_1", { mode: "payment" }], ["evt_2", { payment_status: "unpaid" }], ["evt_3", { metadata: { orgId: a.orgId, price: "price_other" } }], ["evt_4", { metadata: { orgId: a.orgId } }]] as const) {
      expect((await deliver(a.t, session(id, change), signed)).status).toBe(200);
      expect(await status(), id).toBeNull();
    }
    await a.t.run(async (ctx: any) => ctx.db.patch(a.orgId, { deletingAt: Date.now() }));
    await deliver(a.t, session("evt_5", {}), signed);
    const after = await a.t.run(async (ctx: any) => ({ org: await ctx.db.get(a.orgId), rows: (await ctx.db.query("billingEvents").collect()).length }));
    expect(after.org.billing).toBeUndefined();
    expect(after.rows).toBe(0);
    await a.t.run(async (ctx: any) => ctx.db.patch(a.orgId, { deletingAt: undefined }));
    await deliver(a.t, session("evt_6", {}), signed);
    expect(await status()).toBe("active");
  });
});
