import { v } from "convex/values";
import { DAY as LIMIT_DAY } from "@convex-dev/rate-limiter";
import { httpAction, internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { bookingLimiter as limiter } from "./rateLimit";
import type { Doc, Id } from "./_generated/dataModel";
import { ownerOf, requireMember, requireWriter } from "./identity";
import { fail } from "./errors";
import { canReadRecord } from "./authority/reads";
import { normalAddress, settingsProblems, siteUrl, validAddress } from "./lib/campaignText";
import { standardItem } from "./lib/campaign";
import { HOLD, type Page, bookable, busy, confirm, dailyCap, isOpen, logActivity, pageName, personFor, priceMinor, slotsFor } from "./lib/booking";
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
  const shown = { open: true as const, name: page.record.title, description: page.description, minutes: page.rules.minutes, price: page.price, currency: page.currency, paid: !!page.paymentLink, slots: await slotsFor(ctx, page, Date.now()) };
  // Only people in the workspace hear that confirmations will not go out.
  const identity = await ctx.auth.getUserIdentity(), user = identity && await ctx.db.query("users").withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier)).unique();
  const member = user && await ctx.db.query("members").withIndex("by_org_user", (q) => q.eq("orgId", page.org._id).eq("userId", user._id)).unique();
  return member && settingsProblems(page.org.emailSettings).length ? { ...shown, notice: "Email sending is not set up, so people who book here get no confirmation email. Only your team sees this." } : shown;
} });

const HOLDS_PER_PAGE = 3;
const limited = (retryAfterMs: number) => ({ status: "limited" as const, retryAfter: Math.max(1, Math.ceil(retryAfterMs / 1000)) });
// What a paid hold expects from Stripe: a paid page always has a currency (pageRules, bookable).
const expected = (page: Page) => (page.paymentLink && page.currency ? { expectedMinor: priceMinor(page), expectedCurrency: page.currency } : {});
const daily = () => ({ key: "", config: { kind: "fixed window" as const, rate: dailyCap(), period: LIMIT_DAY, start: 0 } });

export const book = mutation({ args: { pageId: v.string(), start: v.number(), name: v.string(), email: v.string(), note: v.optional(v.string()), zone: v.optional(v.string()), s: v.optional(v.string()), hp: v.optional(v.string()) }, handler: async (ctx, a) => {
  const page = await bookable(ctx, a.pageId);
  if (!page) return { status: "closed" as const };
  // Bots fill the hidden field. A person whose browser filled it can try again.
  if (a.hp?.trim()) fail("VALIDATION", "We could not book this time. Please try again.");
  const name = clean(a.name, 100), email = normalAddress(a.email), note = clean(a.note, 2000), now = Date.now(), orgId = page.org._id;
  if (!name) fail("VALIDATION", "Your name is required");
  if (!validAddress(email)) fail("VALIDATION", "A valid email is required");
  // Every attempt costs a token before any open time is computed, so probing is metered too.
  const perPage = await limiter.limit(ctx, "bookingPage", { key: page.record._id });
  if (!perPage.ok) return limited(perPage.retryAfter ?? 0);
  // Someone back from Stripe (a declined card, a closed tab) is never locked out by their own
  // hold: choosing a time moves the hold there with the same payment link. It keeps its first
  // expiry, so renewing cannot keep a time blocked. While a payment of theirs waits on the
  // owner's decision, they get no second hold.
  const mine = page.paymentLink ? await ctx.db.query("bookings").withIndex("by_email_hold", (q) => q.eq("orgId", orgId).eq("email", email).eq("status", "held").gt("holdUntil", now)).take(2) : [];
  if (mine.some((b) => b.attention)) fail("VALIDATION", "Your earlier payment is waiting for the owner to look at it. They will be in touch.");
  const own = mine[0];
  // Checked inside this transaction, so of two people racing for one time exactly one wins.
  if (!(await isOpen(ctx, page, a.start, now, own?._id))) return { status: "taken" as const };
  const perEmail = await limiter.limit(ctx, "bookingEmail", { key: `${orgId}:${email}` });
  if (!perEmail.ok) return limited(perEmail.retryAfter ?? 0);
  if (own) {
    await ctx.db.patch(own._id, { pageRecordId: page.record._id, start: a.start, end: a.start + page.rules.minutes * MINUTE, name, ...(note ? { note } : {}), ...expected(page) });
    return { status: "held" as const, pay: payUrl(page.paymentLink!, own.token, email) };
  }
  // Unpaid holds block times for others, so few may wait at once: 3 a page, 1 an address.
  if (page.paymentLink) {
    const holds = (await ctx.db.query("bookings").withIndex("by_page_hold", (q) => q.eq("pageRecordId", page.record._id).eq("status", "held").gt("holdUntil", now)).take(50)).filter((h) => !h.attention);
    if (holds.length >= HOLDS_PER_PAGE) return limited(Math.min(...holds.map((h) => h.holdUntil!)) - now);
  }
  // The daily cap counts confirmed bookings: a free one takes from it now, a paid one when Stripe confirms it.
  const day = page.paymentLink ? await limiter.check(ctx, "bookingDaily", { ...daily(), key: orgId }) : await limiter.limit(ctx, "bookingDaily", { ...daily(), key: orgId });
  if (!day.ok) return limited(day.retryAfter ?? 0);
  const personRecordId = await personFor(ctx, orgId, name, email, a.email);
  const send = a.s ? await ctx.db.query("emailSends").withIndex("by_token", (q) => q.eq("token", a.s!)).unique() : null, from = send?.orgId === orgId ? send : null;
  const campaignRecordId = from?.campaignRecordId ?? page.campaignId ?? undefined, token = newToken();
  const id = await ctx.db.insert("bookings", { orgId, pageRecordId: page.record._id, personRecordId, start: a.start, end: a.start + page.rules.minutes * MINUTE, name, email, ...(note ? { note } : {}), ...(a.zone && validZone(a.zone) ? { zone: a.zone } : {}), status: "held", holdUntil: now + HOLD, token, ...(from ? { sendId: from._id } : {}), ...(campaignRecordId ? { campaignRecordId } : {}), ...expected(page) });
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
// Unknown or malformed ids answer before the limiter, so they write nothing.
export const hookToken = internalMutation({ args: { orgId: v.string() }, handler: async (ctx, { orgId }) => {
  const id = ctx.db.normalizeId("orgs", orgId);
  if (!id || !(await ctx.db.get(id))) return null;
  return (await limiter.limit(ctx, "stripeHook", { key: id })).ok;
} });

export const stripeWebhook = httpAction(async (ctx, request) => {
  const orgId = new URL(request.url).pathname.split("/")[3] ?? "";
  const allowed: boolean | null = await ctx.runMutation(internal.bookings.hookToken, { orgId });
  if (allowed === null) return new Response("Payments are not set up", { status: 503 });
  if (!allowed) return new Response("Too many requests", { status: 429 });
  const found = await ctx.runQuery(internal.bookings.secretFor, { orgId });
  if (!found) return new Response("Payments are not set up", { status: 503 });
  const body = await request.text();
  if (!(await verifyStripe(found.secret, request.headers.get("stripe-signature"), body, Date.now()))) return new Response("Invalid signature", { status: 400 });
  let event: any;
  try { event = JSON.parse(body); } catch { return new Response("Invalid JSON", { status: 400 }); }
  const session = event?.data?.object ?? {}, type = event?.type;
  if (typeof event?.id !== "string" || typeof session.client_reference_id !== "string") return new Response("ok");
  const ids = { orgId: found.orgId, eventId: event.id.slice(0, 200), token: session.client_reference_id.slice(0, 200) };
  // Only the verified event says what was paid; nothing else is trusted for the amount.
  // Bank debits and vouchers finish later, with async_payment_succeeded or _failed.
  const succeeded = (type === "checkout.session.completed" && session.payment_status === "paid") || type === "checkout.session.async_payment_succeeded";
  if (succeeded && Number.isSafeInteger(session.amount_total) && typeof session.currency === "string")
    await ctx.runMutation(internal.bookings.paid, { ...ids, amountMinor: session.amount_total, currency: session.currency.slice(0, 10).toLowerCase(), sessionId: String(session.id ?? "").slice(0, 200), livemode: event.livemode === true });
  if (type === "checkout.session.async_payment_failed") await ctx.runMutation(internal.bookings.failed, ids);
  return new Response("ok");
});

// The booking an event names, once per event id, only in the workspace whose secret signed it.
async function eventBooking(ctx: MutationCtx, orgId: Id<"orgs">, token: string, eventId: string) {
  const booking = await ctx.db.query("bookings").withIndex("by_token", (q) => q.eq("token", token)).unique(), key = `${orgId}:${eventId}`;
  if (!booking || booking.orgId !== orgId || booking.paidAt) return null;
  if (await ctx.db.query("webhookEvents").withIndex("by_event", (q) => q.eq("provider", "stripe").eq("eventId", key)).unique()) return null;
  await ctx.db.insert("webhookEvents", { provider: "stripe", eventId: key, at: Date.now() });
  return booking;
}

export const paid = internalMutation({ args: { orgId: v.id("orgs"), eventId: v.string(), token: v.string(), amountMinor: v.number(), currency: v.string(), sessionId: v.string(), livemode: v.boolean() }, handler: async (ctx, a) => {
  const booking = await eventBooking(ctx, a.orgId, a.token, a.eventId);
  if (!booking) return;
  const now = Date.now(), title = await pageName(ctx, booking), amount = money(a.amountMinor, a.currency);
  await ctx.db.patch(booking._id, { paidAt: now, amountMinor: a.amountMinor, currency: a.currency, stripeSessionId: a.sessionId, livemode: a.livemode });
  await logActivity(ctx, booking.orgId, booking.personRecordId, `Paid ${amount} for ${title}`, "payment", now);
  if (booking.status === "confirmed") return;
  // Any Payment Link on the same Stripe account can carry this token, so the amount must
  // cover the page's price (a promotion code lands here too; the owner confirms it anyway).
  const asked = booking.expectedCurrency, min = booking.expectedMinor ?? 0;
  const short = asked !== undefined && (a.currency !== asked || a.amountMinor < min), owned = booking.cancelReason === "cancelled";
  const free = !(await busy(ctx, booking.orgId, booking.start, booking.end, (booking.end - booking.start) / MINUTE, now, booking._id)).some((b) => b.start < booking.end && booking.start < b.end);
  const attention = short ? `Paid ${amount}, but the page asks for ${money(min, asked!)}` : owned ? "Paid, but the booking was cancelled" : !free ? "Paid, but the hold ran out and the time was taken" : null;
  if (!attention) {
    if (dailyCap() > 0) await limiter.limit(ctx, "bookingDaily", { ...daily(), key: booking.orgId });
    return confirm(ctx, (await ctx.db.get(booking._id))!);
  }
  // A payment the owner must look at keeps its time while the time is still its own:
  // the hold no longer runs out, so nobody else books over it before they decide.
  if (short && !owned && free) await ctx.db.patch(booking._id, { status: "held", holdUntil: Number.MAX_SAFE_INTEGER, cancelReason: undefined, attention });
  else await ctx.db.patch(booking._id, { status: "cancelled", cancelReason: owned ? "cancelled" : short ? "underpaid" : "expired", attention });
  const owner = await ownerOf(ctx, booking.orgId);
  await ctx.db.insert("agentInbox", { orgId: booking.orgId, text: `${booking.name} (${booking.email}) paid ${amount} for ${title} at ${new Date(booking.start).toISOString().slice(0, 16).replace("T", " ")} UTC. ${attention}. On the booking page, confirm it anyway, or release it and rebook or refund them.`, source: "booking", from: { kind: "user", id: owner.user._id }, status: "pending", audience: "org", recordId: booking.personRecordId });
} });

// A delayed payment that failed: the hold ends and the time opens up.
export const failed = internalMutation({ args: { orgId: v.id("orgs"), eventId: v.string(), token: v.string() }, handler: async (ctx, a) => {
  const booking = await eventBooking(ctx, a.orgId, a.token, a.eventId);
  if (booking?.status === "held") await ctx.db.patch(booking._id, { status: "cancelled", cancelReason: "payment failed" });
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
    return { id: b._id, start: b.start, end: b.end, status: b.status, name: shown ? b.name : null, email: shown ? b.email : null, note: shown ? b.note ?? null : null, personId: shown ? b.personRecordId : null, paid: b.paidAt && b.currency ? money(b.amountMinor ?? 0, b.currency) : null, attention: b.attention ?? null, decide: !!b.attention && principal.member.role !== "member", test: b.livemode === false, held: b.status === "held" && !b.attention && (b.holdUntil ?? 0) > now };
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

// An admin's decision on a booking that needs one (a payment short, in another currency,
// or after its time was lost). Each decision lands on the person's timeline in their name.
export const resolve = mutation({ args: { orgId: v.id("orgs"), bookingId: v.id("bookings"), action: v.union(v.literal("confirm"), v.literal("release")) }, handler: async (ctx, args) => {
  const member = await requireWriter(ctx, args.orgId, "admin"), b = await ctx.db.get(args.bookingId);
  if (!b || b.orgId !== args.orgId) fail("NOT_FOUND", "Booking not found");
  await readablePage(ctx, member, b.pageRecordId);
  if (!b.attention) fail("CONFLICT", "This booking needs no decision");
  const now = Date.now(), who = member.user.name;
  if (args.action === "release") {
    await ctx.db.patch(b._id, { status: "cancelled", cancelReason: "released", attention: undefined, holdUntil: undefined });
    return logActivity(ctx, b.orgId, b.personRecordId, `Released by ${who}, refund in Stripe: ${b.attention}`, "other", now, member.actor);
  }
  if ((await busy(ctx, b.orgId, b.start, b.end, (b.end - b.start) / MINUTE, now, b._id)).some((x) => x.start < b.end && b.start < x.end)) fail("CONFLICT", "That time is taken now. Release it and rebook them.");
  await ctx.db.patch(b._id, { attention: undefined, holdUntil: undefined });
  await logActivity(ctx, b.orgId, b.personRecordId, `Confirmed anyway by ${who}: ${b.attention}`, "other", now, member.actor);
  if (dailyCap() > 0) await limiter.limit(ctx, "bookingDaily", { ...daily(), key: b.orgId });
  await confirm(ctx, (await ctx.db.get(b._id))!);
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
