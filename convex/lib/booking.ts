declare const process: { env: Record<string, string | undefined> };
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { ownerOf, type Actor } from "../identity";
import { fail } from "../errors";
import { applyChange } from "./applyChange";
import { standardItem, type Item } from "./campaign";
import { pickPage, tagsIn } from "./campaignText";
import { matches } from "./intake";
import { allDay, fromInstant } from "./values";
import { DAY, HOURS_HELP, MINUTE, minorPer, openSlots, parseHours, paymentLinkOk, validZone, type Busy, type Rules } from "./bookingTime";

type Ctx = QueryCtx | MutationCtx;
export const BOOKING: Actor = { kind: "automation", id: "Booking page" };
export const HOLD = 30 * MINUTE;
const value = (record: Doc<"records">, field: Doc<"fields"> | undefined) => (field ? record.values[field._id] : undefined);
const num = (raw: unknown, fallback: number) => (typeof raw === "number" && Number.isFinite(raw) ? raw : fallback);
// Missing or unreadable means zero (AGENTS.md): no page takes bookings until it is set.
export const dailyCap = () => { const raw = process.env.REMOLD_BOOKING_DAILY_CAP?.trim() ?? "", n = Number(raw); return /^\d+$/.test(raw) && Number.isSafeInteger(n) ? n : 0; };

// Every write to a Booking page goes through applyChange, which calls this, so the
// app, an adopted suggestion and the API all keep pages bookable as written.
export function pageRules(object: Doc<"objects">, fields: Doc<"fields">[], before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  if (!object.isStandard || object.key !== "bookingPage" || !after) return;
  const f = Object.fromEntries(fields.filter((field) => !field.retired).map((field) => [field.key, field]));
  const changed = (key: string) => !!f[key] && JSON.stringify(before?.[f[key]._id] ?? null) !== JSON.stringify(after[f[key]._id] ?? null);
  const set = (key: string) => (f[key] ? after[f[key]._id] ?? null : null);
  const whole = (key: string, label: string, min: number, max: number) => { const n = set(key); if (changed(key) && n !== null && (!Number.isInteger(n) || (n as number) < min || (n as number) > max)) fail("VALIDATION", `${label} must be a whole number from ${min} to ${max}`, { fieldId: f[key]!._id }); };
  whole("minutes", "Minutes", 5, 480); whole("noticeHours", "Notice hours", 0, 720); whole("daysAhead", "Days ahead", 1, 365);
  const price = set("price");
  if (changed("price") && price !== null && (price as number) < 0) fail("VALIDATION", "Price cannot be negative", { fieldId: f.price!._id });
  const hours = set("hours"), zone = set("timezone"), link = set("paymentLink");
  if (changed("hours") && hours !== null && !parseHours(String(hours))) fail("VALIDATION", HOURS_HELP, { fieldId: f.hours!._id });
  if (changed("timezone") && zone !== null && !validZone(String(zone))) fail("VALIDATION", 'Timezone must be an IANA zone like "America/New_York"', { fieldId: f.timezone!._id });
  // Which currency a link charges in is the owner's to say; guessing turned correct euro payments into "underpaid".
  if (link !== null && set("currency") === null && (changed("paymentLink") || changed("currency"))) fail("VALIDATION", "Choose the currency your Stripe Payment Link charges in", { fieldId: (f.currency ?? f.paymentLink)!._id });
  if (changed("paymentLink") && link !== null && !paymentLinkOk(String(link))) fail("VALIDATION", "Payment link must be a Stripe link starting https://buy.stripe.com/ or https://checkout.stripe.com/", { fieldId: f.paymentLink!._id });
  if (set("live") === true && (changed("live") || changed("hours") || changed("timezone")) && (!hours || !zone)) fail("VALIDATION", "A live page needs hours and a timezone", { fieldId: f.live!._id });
}

export type Page = { org: Doc<"orgs">; record: Doc<"records">; item: Item; rules: Rules; description: string; price: number | null; currency: string | null; paymentLink: string | null; campaignId: Id<"records"> | null };
// The page behind a public link, or null when it is not taking bookings.
export async function bookable(ctx: Ctx, pageId: string): Promise<Page | null> {
  const id = ctx.db.normalizeId("records", pageId), record = id ? await ctx.db.get(id) : null;
  if (!record || dailyCap() === 0) return null;
  const org = await ctx.db.get(record.orgId), item = await standardItem(ctx, record.orgId, "bookingPage");
  if (!org || org.flags?.readonly || !item || record.objectId !== item.object._id || value(record, item.f.live) !== true) return null;
  const hours = parseHours(String(value(record, item.f.hours) ?? "")), zone = String(value(record, item.f.timezone) ?? "");
  if (!hours || !validZone(zone)) return null;
  const rules = { hours, timezone: zone, minutes: num(value(record, item.f.minutes), 30), noticeHours: num(value(record, item.f.noticeHours), 12), daysAhead: Math.min(num(value(record, item.f.daysAhead), 30), 365) };
  const price = value(record, item.f.price), link = value(record, item.f.paymentLink), campaign = value(record, item.f.campaign), currency = value(record, item.f.currency);
  return { org, record, item, rules, description: String(value(record, item.f.description) ?? ""), price: typeof price === "number" ? price : null, currency: typeof currency === "string" ? currency : null, paymentLink: typeof link === "string" && paymentLinkOk(link) ? link : null, campaignId: (campaign as Id<"records">) ?? null };
}

// What blocks time anywhere in the workspace between `from` and `to`: confirmed
// bookings, holds that have not run out, and timed meetings (taken to last `minutes`).
// Meetings a booking wrote itself are covered by the booking, so a cancel frees the time.
export async function busy(ctx: Ctx, orgId: Id<"orgs">, from: number, to: number, minutes: number, now: number, except?: Id<"bookings">) {
  const out: Busy[] = [];
  for await (const b of ctx.db.query("bookings").withIndex("by_org_start", (q) => q.eq("orgId", orgId).gt("start", from - DAY).lt("start", to))) {
    if (b._id !== except && (b.status === "confirmed" || (b.status === "held" && (b.holdUntil ?? 0) > now))) out.push({ start: b.start, end: b.end });
  }
  const activity = await standardItem(ctx, orgId, "activity"), when = activity?.f.when;
  if (!activity || !when?.slot || !activity.f.type) return out;
  const slot = `${when.slot.kind}${when.slot.index}`, length = minutes * MINUTE;
  for await (const r of (ctx.db.query("records") as any).withIndex(`by_${slot}`, (q: any) => q.eq("orgId", orgId).eq("objectId", activity.object._id).gt(slot, from - length).lt(slot, to)) as AsyncIterable<Doc<"records">>) {
    const at = value(r, when);
    if (value(r, activity.f.type) === "meeting" && value(r, activity.f.source) !== "booking" && typeof at === "number" && !allDay(at)) out.push({ start: Math.floor(at), end: Math.floor(at) + length });
  }
  return out;
}
export const slotsFor = async (ctx: Ctx, page: Page, now: number) => openSlots(page.rules, now, await busy(ctx, page.org._id, now, now + (page.rules.daysAhead + 1) * DAY, page.rules.minutes, now));
export async function isOpen(ctx: Ctx, page: Page, start: number, now: number, except?: Id<"bookings">) {
  const length = page.rules.minutes * MINUTE;
  return openSlots(page.rules, now, await busy(ctx, page.org._id, start, start + length, page.rules.minutes, now, except), { from: start, to: start }).includes(start);
}

export const priceMinor = (page: Page, currency = page.currency ?? "usd") => Math.round((page.price ?? 0) * minorPer(currency));

// Email decides who someone is, and a match is linked, never changed. A public page
// looks the address up through the Email field's index, as typed and lowercased, so a
// person stored with other letter case is not found (a second person is made instead).
// Website intake keeps its full scan: it also matches phones written different ways.
export async function personFor(ctx: MutationCtx, orgId: Id<"orgs">, name: string, email: string, typed: string) {
  const person = await standardItem(ctx, orgId, "person");
  if (!person?.f.name || !person.f.email || !person.f.phone) fail("NOT_FOUND", "Booking needs the person object");
  const slot = person.f.email.slot && `${person.f.email.slot.kind}${person.f.email.slot.index}`;
  for (const form of slot ? new Set([email, typed.trim()]) : []) {
    const hit = await (ctx.db.query("records") as any).withIndex(`by_${slot}`, (q: any) => q.eq("orgId", orgId).eq("objectId", person.object._id).eq(slot, form)).first();
    if (hit) return hit._id as Id<"records">;
  }
  const { byEmail } = slot ? { byEmail: null } : await matches(ctx, { object: person.object, fields: person.f }, email);
  if (byEmail) return byEmail._id;
  return (await applyChange(ctx, await ownerOf(ctx, orgId), { action: "create", orgId, objectId: person.object._id, values: { [person.f.name._id]: name, [person.f.email._id]: email }, reason: "Booked a time" }, { actor: BOOKING })).recordId;
}

// A timeline entry about the person, written as the owner by the booking page.
export async function logActivity(ctx: MutationCtx, orgId: Id<"orgs">, personId: Id<"records">, title: string, type: "meeting" | "payment" | "other", at: number, actor: Actor = BOOKING) {
  const org = await ctx.db.get(orgId), activity = await standardItem(ctx, orgId, "activity");
  if (!org || org.flags?.readonly || !activity?.f.title || !(await ctx.db.get(personId))) return;
  const values = Object.fromEntries(([["title", title], ["type", type], ["when", fromInstant(at)], ["about", personId], ["source", "booking"]] as const).filter(([key]) => activity.f[key]).map(([key, v]) => [activity.f[key]!._id, v]));
  await applyChange(ctx, await ownerOf(ctx, orgId), { action: "create", orgId, objectId: activity.object._id, values, reason: "Booking page" }, { actor });
}
export const pageName = async (ctx: Ctx, booking: Doc<"bookings">) => (await ctx.db.get(booking.pageRecordId))?.title || "Booking";

export async function confirm(ctx: MutationCtx, booking: Doc<"bookings">) {
  await ctx.db.patch(booking._id, { status: "confirmed", cancelReason: undefined });
  await logActivity(ctx, booking.orgId, booking.personRecordId, `${await pageName(ctx, booking)} with ${booking.name}`, "meeting", booking.start);
  await ctx.scheduler.runAfter(0, internal.bookings.notify, { bookingId: booking._id, kind: "confirmed" });
}

// A campaign's booking pages, oldest first: {{bookingLink}} uses the first.
export async function campaignPages(ctx: Ctx, orgId: Id<"orgs">, campaignId: Id<"records">) {
  const item = await standardItem(ctx, orgId, "bookingPage"), field = item?.f.campaign;
  if (!item || !field?.slot) return [];
  const slot = `${field.slot.kind}${field.slot.index}`;
  const rows: Doc<"records">[] = await (ctx.db.query("records") as any).withIndex(`by_${slot}`, (q: any) => q.eq("orgId", orgId).eq("objectId", item.object._id).eq(slot, campaignId)).collect();
  return rows.sort((a, b) => a._creationTime - b._creationTime).map((r) => ({ id: r._id as string, ref: r.ref ?? null, live: value(r, item.f.live) === true }));
}
// The pages an email's {{bookingLink}} tags name, and the first tag that names none
// (or names a page that is not live). Approval needs every tag to name a page; sending
// also needs each to be live, so a page deleted or switched off later holds the email.
export async function linkedPages(ctx: Ctx, campaignId: Id<"records"> | null | undefined, texts: string[]) {
  const tags = texts.flatMap(tagsIn).filter((tag) => tag.name === "bookingLink"), campaign = tags.length && campaignId ? await ctx.db.get(campaignId) : null;
  const pages = campaign ? await campaignPages(ctx, campaign.orgId, campaign._id) : [], named = tags.map((tag) => ({ tag, page: pickPage(pages, tag.arg) }));
  const say = (tag: { arg?: string }) => (tag.arg ? `{{bookingLink:${tag.arg}}}` : "{{bookingLink}}");
  const missing = named.find((n) => !n.page)?.tag, off = named.find((n) => n.page && !n.page.live);
  return { pages, versions: named.map((n) => n.page?.id ?? null), missing: missing ? `${say(missing)} names no booking page on this campaign` : null, problem: missing ? `${say(missing)} names no booking page on this campaign` : off ? `The booking page for ${say(off.tag)} is not live` : null };
}

// A campaign's bookings: kept times (confirmed, or paid even if they need a new time).
export async function campaignBookings(ctx: Ctx, campaignId: Id<"records">) {
  const rows = (await ctx.db.query("bookings").withIndex("by_campaign", (q) => q.eq("campaignRecordId", campaignId)).collect()).filter((b) => b.status === "confirmed" || b.paidAt);
  const revenue = new Map<string, number>(), people = new Map<string, { booked: boolean; paid: boolean }>();
  for (const b of rows) {
    if (b.paidAt && b.currency) revenue.set(b.currency, (revenue.get(b.currency) ?? 0) + (b.amountMinor ?? 0));
    const seen = people.get(b.personRecordId) ?? { booked: false, paid: false };
    people.set(b.personRecordId, { booked: true, paid: seen.paid || !!b.paidAt });
  }
  return { counts: { booked: rows.length, paid: rows.filter((b) => b.paidAt).length, revenue: [...revenue].map(([currency, amountMinor]) => ({ currency, amountMinor })) }, people };
}
