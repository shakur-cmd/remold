declare const process: { env: Record<string, string | undefined> };
import { v } from "convex/values";
import { action, httpAction, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireMember } from "./identity";
import { fail } from "./errors";

// Subscription billing, Stripe TEST MODE ONLY. Off unless REMOLD_BILLING=test and every
// key is a test key; a live key is refused even by mistake. Live billing needs Shakur's
// explicit OK and a code change here. The status is shown, not enforced, for now.
const accessStatus = v.union(v.literal("active"), v.literal("past_due"), v.literal("canceled"));
type Status = "active" | "past_due" | "canceled";

export function billingConfig() {
  const env = process.env;
  if (env.REMOLD_BILLING !== "test") return null;
  const key = env.STRIPE_SECRET_KEY ?? "", webhookSecret = env.STRIPE_WEBHOOK_SECRET ?? "", price = env.REMOLD_PRICE_ID ?? "", appUrl = env.REMOLD_APP_URL ?? "";
  if (/^[a-z]{2}_live_/.test(key)) fail("UNSUPPORTED", "Live Stripe keys are refused: billing runs in test mode only");
  if (!key.startsWith("sk_test_") || !webhookSecret.startsWith("whsec_") || !price.startsWith("price_") || !/^https?:\/\//.test(appUrl)) fail("UNSUPPORTED", "Billing test mode is not fully configured");
  return { key, webhookSecret, price, appUrl: appUrl.replace(/\/$/, "") };
}
const enabled = () => { try { return billingConfig() !== null; } catch { return false; } };

export const status = query({ args: { orgId: v.id("orgs") }, handler: async (ctx, { orgId }) => ({ enabled: enabled(), status: (await requireMember(ctx, orgId)).org.billing?.status ?? null }) });

export const owner = internalQuery({ args: { orgId: v.id("orgs") }, handler: async (ctx, { orgId }) => { await requireMember(ctx, orgId, "owner"); } });

export const checkout = action({ args: { orgId: v.id("orgs") }, handler: async (ctx, { orgId }): Promise<{ url: string }> => {
  const config = billingConfig() ?? fail("UNSUPPORTED", "Billing is off");
  await ctx.runQuery(internal.billing.owner, { orgId });
  const back = `${config.appUrl}/o/${orgId}/settings`;
  const body = new URLSearchParams({ mode: "subscription", "line_items[0][price]": config.price, "line_items[0][quantity]": "1", client_reference_id: orgId, "metadata[orgId]": orgId, "subscription_data[metadata][orgId]": orgId, success_url: `${back}?billing=done`, cancel_url: back });
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers: { authorization: `Bearer ${config.key}`, "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
  const session = await response.json().catch(() => null) as { url?: string } | null;
  if (!response.ok || !session?.url) fail("UNSUPPORTED", "Stripe did not open a checkout session");
  return { url: session.url };
} });

// Stripe's scheme: header "t=<unix>,v1=<hex hmac-sha256 of `${t}.${body}`>", five minutes of tolerance.
export async function verifySignature(body: string, header: string | null, secret: string, now = Date.now()) {
  const parts = (header ?? "").split(",").map(part => part.split("=") as [string, string]);
  const at = Number(parts.find(([k]) => k === "t")?.[1]), signatures = parts.filter(([k]) => k === "v1").map(([, s]) => s);
  if (!Number.isInteger(at) || Math.abs(now / 1000 - at) > 300 || !signatures.length) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${at}.${body}`)))].map(b => b.toString(16).padStart(2, "0")).join("");
  return signatures.some(s => s.length === expected.length && [...s].reduce((diff, c, i) => diff | (c.charCodeAt(0) ^ expected.charCodeAt(i)), 0) === 0);
}

const fromStripe: Record<string, Status> = { active: "active", trialing: "active", past_due: "past_due", unpaid: "past_due", incomplete: "past_due", paused: "past_due", canceled: "canceled", incomplete_expired: "canceled" };
type Change = { orgId: string; eventId: string; type: string; status: Status; customerId?: string; subscriptionId?: string; eventAt: number };
export function billingChange(event: any): Change | null {
  const object = event?.data?.object ?? {}, eventAt = Number(event?.created), eventId = event?.id, type = event?.type;
  if (!Number.isFinite(eventAt) || typeof eventId !== "string" || typeof type !== "string") return null;
  const ids = (customerId: unknown, subscriptionId: unknown) => ({ ...(typeof customerId === "string" ? { customerId } : {}), ...(typeof subscriptionId === "string" ? { subscriptionId } : {}) });
  if (type === "checkout.session.completed") {
    const orgId = object.client_reference_id ?? object.metadata?.orgId;
    return typeof orgId === "string" ? { orgId, eventId, type, status: "active", eventAt, ...ids(object.customer, object.subscription) } : null;
  }
  if (!/^customer\.subscription\.(created|updated|deleted)$/.test(type)) return null;
  const orgId = object.metadata?.orgId, status = type === "customer.subscription.deleted" ? "canceled" : fromStripe[object.status];
  return typeof orgId === "string" && status ? { orgId, eventId, type, status, eventAt, ...ids(object.customer, object.id) } : null;
}

// Every verified event is kept once by its Stripe id, so a redelivery or replay changes nothing.
// The flag follows the workspace's current subscription in (created, event id) order; a new
// subscription takes over only through a completed Checkout. A change writes its from/to row in
// the same transaction as the flag.
export const apply = internalMutation({ args: { orgId: v.string(), eventId: v.string(), type: v.string(), status: accessStatus, customerId: v.optional(v.string()), subscriptionId: v.optional(v.string()), eventAt: v.number() }, handler: async (ctx, args) => {
  const orgId = ctx.db.normalizeId("orgs", args.orgId), org = orgId && await ctx.db.get(orgId);
  if (!org || org.deletingAt) return;
  if (await ctx.db.query("billingEvents").withIndex("by_event", q => q.eq("eventId", args.eventId)).first()) return;
  const now = org.billing, sameSubscription = !now?.subscriptionId || !args.subscriptionId || now.subscriptionId === args.subscriptionId;
  const newer = !now || args.eventAt > now.eventAt || (args.eventAt === now.eventAt && args.eventId > (now.eventId ?? ""));
  const applies = newer && (sameSubscription || args.type === "checkout.session.completed");
  await ctx.db.insert("billingEvents", { orgId: org._id, eventId: args.eventId, type: args.type, created: args.eventAt, subscriptionId: args.subscriptionId, ...(applies ? { from: now?.status ?? "none", to: args.status } : {}) });
  if (applies) await ctx.db.patch(org._id, { billing: { status: args.status, customerId: args.customerId ?? now?.customerId, subscriptionId: args.subscriptionId ?? now?.subscriptionId, eventAt: args.eventAt, eventId: args.eventId } });
} });

export const webhook = httpAction(async (ctx, request) => {
  const config = enabled() ? billingConfig() : null;
  if (!config) return new Response("Not found", { status: 404 });
  const body = await request.text();
  if (!await verifySignature(body, request.headers.get("stripe-signature"), config.webhookSecret)) return new Response("Invalid signature", { status: 400 });
  const event = JSON.parse(body);
  // Webhook secrets look the same in both modes, so the event itself must say test mode.
  if (event.livemode !== false) return new Response("Live events are refused", { status: 400 });
  const change = billingChange(event);
  if (change) await ctx.runMutation(internal.billing.apply, change);
  return new Response(null, { status: 200 });
});
