import { v } from "convex/values";
import { DAY as LIMIT_DAY } from "@convex-dev/rate-limiter";
import { httpAction, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { bookingLimiter as limiter } from "./rateLimit";
import type { Doc, Id } from "./_generated/dataModel";
import { ownerOf, requireMember, requireWriter } from "./identity";
import { fail } from "./errors";
import { canReadRecord } from "./authority/reads";
import { normalAddress, settingsProblems, siteUrl, validAddress } from "./lib/campaignText";
import { standardItem } from "./lib/campaign";
import { HOLD, bookable, busy, confirm, dailyCap, isOpen, logActivity, pageName, personFor, slotsFor } from "./lib/booking";
import { MINUTE, calendarLink, money, payUrl, validZone, verifyStripe, when } from "./lib/bookingTime";
import { sendTransactional } from "./campaignSend";

// Public booking pages (/book/<pageId> in the app). Visitors read a page and book a
// time without signing in; a paid page holds the time until Stripe says it is paid.
// Pages themselves are ordinary Booking page records (convex/lib/booking.ts).
const CLOSED = { open: false as const, message: "This page is not taking bookings." };
const newToken = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
const clean = (text: string | undefined, max: number) => text?.replace(/\s+/g, " ").trim().slice(0, max) || undefined;

export const page = query({ args: { pageId: v.string() }, handler: async (ctx, { pageId }) => {
  const page = await bookable(ctx, pageId);
  if (!page) return CLOSED;
  const shown = { open: true as const, name: page.record.title, description: page.description, minutes: page.rules.minutes, price: page.price, paid: !!page.paymentLink, slots: await slotsFor(ctx, page, Date.now()) };
  // Only people in the workspace hear that confirmations will not go out.
  const identity = await ctx.auth.getUserIdentity(), user = identity && await ctx.db.query("users").withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier)).unique();
  const member = user && await ctx.db.query("members").withIndex("by_org_user", (q) => q.eq("orgId", page.org._id).eq("userId", user._id)).unique();
  return member && settingsProblems(page.org.emailSettings).length ? { ...shown, notice: "Email sending is not set up, so people who book here get no confirmation email. Only your team sees this." } : shown;
} });

export const book = mutation({ args: { pageId: v.string(), start: v.number(), name: v.string(), email: v.string(), note: v.optional(v.string()), zone: v.optional(v.string()), s: v.optional(v.string()), website: v.optional(v.string()) }, handler: async (ctx, a) => {
  const page = await bookable(ctx, a.pageId);
  if (!page) return { status: "closed" as const };
  // Bots fill the hidden field. They get the answer a person would, and nothing is written.
  if (a.website?.trim()) return { status: "confirmed" as const };
  const name = clean(a.name, 100), email = normalAddress(a.email), note = clean(a.note, 2000), now = Date.now(), orgId = page.org._id;
  if (!name) fail("VALIDATION", "Your name is required");
  if (!validAddress(email)) fail("VALIDATION", "A valid email is required");
  // Checked inside this transaction, so of two people racing for one time exactly one wins.
  if (!(await isOpen(ctx, page, a.start, now))) return { status: "taken" as const };
  for (const take of [() => limiter.limit(ctx, "bookingPage", { key: page.record._id }), () => limiter.limit(ctx, "bookingEmail", { key: `${orgId}:${email}` }), () => limiter.limit(ctx, "bookingDaily", { key: orgId, config: { kind: "fixed window", rate: dailyCap(), period: LIMIT_DAY, start: 0 } })]) {
    const result = await take();
    if (!result.ok) return { status: "limited" as const, retryAfter: Math.max(1, Math.ceil((result.retryAfter ?? 0) / 1000)) };
  }
  const personRecordId = await personFor(ctx, orgId, name, email);
  const send = a.s ? await ctx.db.query("emailSends").withIndex("by_token", (q) => q.eq("token", a.s!)).unique() : null, from = send?.orgId === orgId ? send : null;
  const campaignRecordId = from?.campaignRecordId ?? page.campaignId ?? undefined, token = newToken();
  const id = await ctx.db.insert("bookings", { orgId, pageRecordId: page.record._id, personRecordId, start: a.start, end: a.start + page.rules.minutes * MINUTE, name, email, ...(note ? { note } : {}), ...(a.zone && validZone(a.zone) ? { zone: a.zone } : {}), status: "held", holdUntil: now + HOLD, token, ...(from ? { sendId: from._id } : {}), ...(campaignRecordId ? { campaignRecordId } : {}) });
  if (page.paymentLink) return { status: "held" as const, pay: payUrl(page.paymentLink, token, email) };
  await confirm(ctx, (await ctx.db.get(id))!);
  return { status: "confirmed" as const };
} });

// Holds that ran out already free their time (busy() ignores them); this marks them.
export const expire = internalMutation({ args: {}, handler: async (ctx) => {
  for (const b of await ctx.db.query("bookings").withIndex("by_status_hold", (q) => q.eq("status", "held").lt("holdUntil", Date.now())).take(200)) await ctx.db.patch(b._id, { status: "cancelled", cancelReason: "expired" });
} });

// Stripe. The signing secret is stored per workspace and read only here.
export const secretFor = internalQuery({ args: { orgId: v.string() }, handler: async (ctx, { orgId }) => {
  const id = ctx.db.normalizeId("orgs", orgId), row = id ? await ctx.db.query("paymentSecrets").withIndex("by_org", (q) => q.eq("orgId", id)).unique() : null;
  return row ? { orgId: row.orgId, secret: row.stripeWebhookSecret } : null;
} });

export const stripeWebhook = httpAction(async (ctx, request) => {
  const found = await ctx.runQuery(internal.bookings.secretFor, { orgId: new URL(request.url).pathname.split("/")[3] ?? "" });
  if (!found) return new Response("Payments are not set up", { status: 503 });
  const body = await request.text();
  if (!(await verifyStripe(found.secret, request.headers.get("stripe-signature"), body, Date.now()))) return new Response("Invalid signature", { status: 400 });
  let event: any;
  try { event = JSON.parse(body); } catch { return new Response("Invalid JSON", { status: 400 }); }
  const session = event?.data?.object ?? {};
  // Only the verified event says what was paid; nothing else is trusted for the amount.
  if (event?.type === "checkout.session.completed" && session.payment_status === "paid" && typeof event.id === "string" && typeof session.client_reference_id === "string" && Number.isSafeInteger(session.amount_total) && typeof session.currency === "string")
    await ctx.runMutation(internal.bookings.paid, { orgId: found.orgId, eventId: event.id.slice(0, 200), token: session.client_reference_id.slice(0, 200), amountMinor: session.amount_total, currency: session.currency.slice(0, 10).toLowerCase(), sessionId: String(session.id ?? "").slice(0, 200) });
  return new Response("ok");
});

export const paid = internalMutation({ args: { orgId: v.id("orgs"), eventId: v.string(), token: v.string(), amountMinor: v.number(), currency: v.string(), sessionId: v.string() }, handler: async (ctx, a) => {
  const booking = await ctx.db.query("bookings").withIndex("by_token", (q) => q.eq("token", a.token)).unique(), eventId = `${a.orgId}:${a.eventId}`;
  if (!booking || booking.orgId !== a.orgId || booking.paidAt) return;
  if (await ctx.db.query("webhookEvents").withIndex("by_event", (q) => q.eq("provider", "stripe").eq("eventId", eventId)).unique()) return;
  const now = Date.now(), title = await pageName(ctx, booking);
  await ctx.db.insert("webhookEvents", { provider: "stripe", eventId, at: now });
  await ctx.db.patch(booking._id, { paidAt: now, amountMinor: a.amountMinor, currency: a.currency, stripeSessionId: a.sessionId });
  await logActivity(ctx, booking.orgId, booking.personRecordId, `Paid ${money(a.amountMinor, a.currency)} for ${title}`, "payment", now);
  if (booking.status === "confirmed") return;
  const free = booking.cancelReason !== "cancelled" && !(await busy(ctx, booking.orgId, booking.start, booking.end, (booking.end - booking.start) / MINUTE, now, booking._id)).some((b) => b.start < booking.end && booking.start < b.end);
  if (free) return confirm(ctx, (await ctx.db.get(booking._id))!);
  const why = booking.cancelReason === "cancelled" ? "the booking was cancelled" : "the hold ran out and the time was taken";
  await ctx.db.patch(booking._id, { status: "cancelled", cancelReason: booking.cancelReason ?? "expired", attention: `Paid, but ${why}` });
  const owner = await ownerOf(ctx, booking.orgId);
  await ctx.db.insert("agentInbox", { orgId: booking.orgId, text: `${booking.name} (${booking.email}) paid ${money(a.amountMinor, a.currency)} for ${title} at ${new Date(booking.start).toISOString().slice(0, 16).replace("T", " ")} UTC, but ${why}. Rebook or refund them.`, source: "booking", from: { kind: "user", id: owner.user._id }, status: "pending", audience: "org", recordId: booking.personRecordId });
} });

// Emails for one booking, through campaign email's one-off sender and its gates. Not
// being set up is fine: the booking stands and the owner sees why on the page.
export const mailFor = internalQuery({ args: { bookingId: v.id("bookings"), kind: v.union(v.literal("confirmed"), v.literal("cancelled")) }, handler: async (ctx, { bookingId, kind }) => {
  const b = await ctx.db.get(bookingId);
  if (!b) return null;
  const page = await ctx.db.get(b.pageRecordId), item = await standardItem(ctx, b.orgId, "bookingPage"), org = await ctx.db.get(b.orgId);
  const pageZone = String((page && item?.f.timezone && page.values[item.f.timezone._id]) || "UTC"), zone = b.zone ?? (validZone(pageZone) ? pageZone : "UTC");
  const title = page?.title || "Booking", time = when(b.start, zone), minutes = Math.round((b.end - b.start) / MINUTE), key = `booking-${b._id}-${kind}`;
  if (kind === "cancelled") return { orgId: b.orgId, mails: [{ to: b.email, subject: `Cancelled: ${title}, ${time}`, text: `Hi ${b.name},\n\nYour ${title} on ${time} is cancelled. Reply to this email if you want a new time.`, key }] };
  const owner = org?.emailSettings?.replyTo || (await ownerOf(ctx, b.orgId)).user.email;
  const paid = b.paidAt && b.currency ? `\nPaid: ${money(b.amountMinor ?? 0, b.currency)}` : "";
  return { orgId: b.orgId, mails: [
    { to: b.email, subject: `Booked: ${title}, ${time}`, text: `Hi ${b.name},\n\nYou are booked for ${title} on ${time} (${minutes} minutes).${paid}\n\nAdd it to your calendar: ${calendarLink(title, b.start, b.end, `Booked through ${org?.name ?? "Remold"}`)}\n\nTo change or cancel, reply to this email.`, key },
    ...(owner ? [{ to: owner, subject: `New booking: ${title} with ${b.name}`, text: `${b.name} <${b.email}> booked ${title} on ${when(b.start, validZone(pageZone) ? pageZone : "UTC")} (${minutes} minutes).${paid}\n\nNote: ${b.note ?? "(none)"}`, key: `${key}-owner` }] : []),
  ] };
} });
export const notify = internalAction({ args: { bookingId: v.id("bookings"), kind: v.union(v.literal("confirmed"), v.literal("cancelled")) }, handler: async (ctx, args) => {
  const found: { orgId: Id<"orgs">; mails: { to: string; subject: string; text: string; key: string }[] } | null = await ctx.runQuery(internal.bookings.mailFor, args);
  for (const mail of found?.mails ?? []) await sendTransactional(ctx, { orgId: found!.orgId, to: mail.to, subject: mail.subject, text: mail.text, idempotencyKey: mail.key });
} });

// The owner's side: a page's bookings, cancelling one, and the Payments settings card.
async function readablePage(ctx: any, principal: Awaited<ReturnType<typeof requireMember>>, pageId: Id<"records">) {
  const item = await standardItem(ctx, principal.org._id, "bookingPage"), record = await ctx.db.get(pageId) as Doc<"records"> | null;
  if (!item || !record || record.orgId !== principal.org._id || record.objectId !== item.object._id || !canReadRecord(principal, item.object, record)) fail("NOT_FOUND", "Booking page not found");
  return record;
}
export const forPage = query({ args: { orgId: v.id("orgs"), pageId: v.id("records") }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId), page = await readablePage(ctx, principal, args.pageId), person = await standardItem(ctx, args.orgId, "person"), now = Date.now();
  const rows = (await ctx.db.query("bookings").withIndex("by_page_start", (q) => q.eq("pageRecordId", page._id)).collect()).filter((b) => b.status !== "cancelled" || b.cancelReason !== "expired" || b.paidAt);
  const ordered = [...rows.filter((b) => b.end >= now), ...rows.filter((b) => b.end < now).reverse()];
  return Promise.all(ordered.map(async (b) => {
    const record = await ctx.db.get(b.personRecordId), shown = !!record && !!person && canReadRecord(principal, person.object, record);
    return { id: b._id, start: b.start, end: b.end, status: b.status, name: shown ? b.name : null, email: shown ? b.email : null, note: shown ? b.note ?? null : null, personId: shown ? b.personRecordId : null, paid: b.paidAt && b.currency ? money(b.amountMinor ?? 0, b.currency) : null, attention: b.attention ?? null, held: b.status === "held" && (b.holdUntil ?? 0) > now };
  }));
} });

export const cancel = mutation({ args: { orgId: v.id("orgs"), bookingId: v.id("bookings"), notify: v.boolean() }, handler: async (ctx, args) => {
  const member = await requireWriter(ctx, args.orgId), b = await ctx.db.get(args.bookingId);
  if (!b || b.orgId !== args.orgId) fail("NOT_FOUND", "Booking not found");
  await readablePage(ctx, member, b.pageRecordId);
  if (b.status === "cancelled") fail("CONFLICT", "This booking is already cancelled");
  await ctx.db.patch(b._id, { status: "cancelled", cancelReason: "cancelled" });
  await logActivity(ctx, b.orgId, b.personRecordId, `Cancelled: ${await pageName(ctx, b)} with ${b.name}`, "other", Date.now());
  if (args.notify) await ctx.scheduler.runAfter(0, internal.bookings.notify, { bookingId: b._id, kind: "cancelled" });
} });

export const paymentSettings = query({ args: { orgId: v.id("orgs") }, handler: async (ctx, args) => {
  await requireMember(ctx, args.orgId, "admin");
  const row = await ctx.db.query("paymentSecrets").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).unique();
  return { webhookUrl: `${siteUrl()}/webhooks/stripe/${args.orgId}`, secretSet: !!row };
} });
// Write-only: the secret is never returned. An empty value removes it.
export const savePaymentSecret = mutation({ args: { orgId: v.id("orgs"), secret: v.string() }, handler: async (ctx, args) => {
  await requireWriter(ctx, args.orgId, "admin");
  const secret = args.secret.trim(), row = await ctx.db.query("paymentSecrets").withIndex("by_org", (q) => q.eq("orgId", args.orgId)).unique();
  if (!secret) { if (row) await ctx.db.delete(row._id); return; }
  if (!/^whsec_[A-Za-z0-9+/=_-]{8,200}$/.test(secret)) fail("VALIDATION", "Paste the signing secret from Stripe; it starts with whsec_");
  if (row) await ctx.db.patch(row._id, { stripeWebhookSecret: secret }); else await ctx.db.insert("paymentSecrets", { orgId: args.orgId, stripeWebhookSecret: secret });
} });
