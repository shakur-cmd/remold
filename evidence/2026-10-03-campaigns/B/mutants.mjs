// Breaks one booking rule at a time and runs convex/bookings.test.ts; each mutant must be caught.
// Run from the repo root: node evidence/2026-10-03-campaigns/B/mutants.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const mutants = [
  ["notice ignored", "convex/lib/bookingTime.ts", "earliest = now + rules.noticeHours * HOUR", "earliest = now"],
  ["horizon ignored", "convex/lib/bookingTime.ts", "start > latest ||", ""],
  ["zone ignored (UTC wall clock)", "convex/lib/bookingTime.ts", "latest = now + rules.daysAhead * DAY, zone = rules.timezone;", "latest = now + rules.daysAhead * DAY, zone = \"UTC\";"],
  ["busy ignored", "convex/lib/bookingTime.ts", "if (!busy.some((b) => b.start < start + length && start < b.end)) out.add(start);", "out.add(start);"],
  ["expired holds still block", "convex/lib/booking.ts", "(b.holdUntil ?? 0) > now", "true"],
  ["meetings ignored", "convex/lib/booking.ts", "value(r, activity.f.type) === \"meeting\"", "false"],
  ["slot not re-checked on book", "convex/bookings.ts", "if (!(await isOpen(ctx, page, a.start, now))) return { status: \"taken\" as const };", ""],
  ["live not required", "convex/lib/booking.ts", "|| value(record, item.f.live) !== true", ""],
  ["missing cap allowed", "convex/lib/booking.ts", "if (!record || dailyCap() === 0) return null;", "if (!record) return null;"],
  ["readonly allowed", "convex/lib/booking.ts", "org.flags?.readonly || ", ""],
  ["existing person updated", "convex/lib/booking.ts", "if (hit) return hit._id as Id<\"records\">;", "if (hit) { await ctx.db.patch(hit._id, { title: name }); return hit._id as Id<\"records\">; }"],
  ["signature not checked", "convex/bookings.ts", "if (!(await verifyStripe(found.secret, request.headers.get(\"stripe-signature\"), body, Date.now())))", "if (false)"],
  ["stale timestamp allowed", "convex/lib/bookingTime.ts", "|| Math.abs(now / 1000 - Number(t)) > 300", ""],
  ["other org's booking accepted", "convex/bookings.ts", "if (!booking || booking.orgId !== orgId || booking.paidAt) return null;", "if (!booking || booking.paidAt) return null;"],
  ["unpaid accepted", "convex/bookings.ts", "&& session.payment_status === \"paid\"", ""],
  ["paid confirms even when taken", "convex/bookings.ts", ": !free ? \"Paid, but the hold ran out and the time was taken\"", ": false ? \"\""],
  ["agents may publish", "convex/authority/agentGuards.ts", "if (field === live && to === true)", "if (false)"],
  ["send attribution dropped", "convex/bookings.ts", "...(from ? { sendId: from._id } : {}), ", ""],
  ["public page leaks the payment link", "convex/bookings.ts", "paid: !!page.paymentLink,", "paid: !!page.paymentLink, link: page.paymentLink,"],
  ["honeypot ignored", "convex/bookings.ts", "if (a.hp?.trim()) fail(", "if (false) fail("],
  // Round 2: the verifier's four survivors, then one per round 2 rule.
  ["cross-org send token attributes", "convex/bookings.ts", "from = send?.orgId === orgId ? send : null", "from = send"],
  ["name keeps line breaks", "convex/bookings.ts", "text?.replace(/\\s+/g, \" \").trim()", "text?.trim()"],
  ["visitor zone not validated", "convex/bookings.ts", "...(a.zone && validZone(a.zone) ? { zone: a.zone } : {})", "...(a.zone ? { zone: a.zone } : {})"],
  ["paid confirms an owner-cancelled booking", "convex/bookings.ts", ": booking.cancelReason === \"cancelled\" ? \"Paid, but the booking was cancelled\"", ": false ? \"\""],
  ["underpayment confirms", "convex/bookings.ts", "a.amountMinor < (booking.expectedMinor ?? 0)", "false"],
  ["other currency confirms", "convex/bookings.ts", "a.currency !== booking.expectedCurrency || ", ""],
  ["zero-decimal currencies divided by 100", "convex/lib/bookingTime.ts", "ZERO_DECIMAL.has(currency.toLowerCase()) ? 1 : 100", "100"],
  ["async success ignored", "convex/bookings.ts", " || type === \"checkout.session.async_payment_succeeded\"", ""],
  ["async failure ignored", "convex/bookings.ts", "if (type === \"checkout.session.async_payment_failed\") await ctx.runMutation(internal.bookings.failed, ids);", ""],
  ["livemode not recorded", "convex/bookings.ts", ", livemode: a.livemode });", " });"],
  ["probing not metered", "convex/bookings.ts", "if (!perPage.ok) return limited(perPage.retryAfter ?? 0);", ""],
  ["holds count against the daily cap", "convex/bookings.ts", "await limiter.check(ctx, \"bookingDaily\"", "await limiter.limit(ctx, \"bookingDaily\""],
  ["no limit on holds per page", "convex/bookings.ts", ">= HOLDS_PER_PAGE ? holds", ">= 99 ? holds"],
  ["no limit on holds per address", "convex/bookings.ts", ": holds.filter((h) => h.email === email)", ": []"],
  ["webhook not rate limited", "convex/bookings.ts", "if (!(await ctx.runMutation(internal.bookings.hookToken, { orgId }))) return", "if (false) return"],
  ["stale booking link sends", "convex/lib/campaign.ts", "if (links.problem) problems.push(links.problem);", ""],
  ["linked pages not in the content version", "convex/lib/campaign.ts", "...(pages.length ? { pages } : {})", ""],
  ["repeated local time gets the later instant", "convex/lib/bookingTime.ts", "Math.min(...found)", "Math.max(...found)"],
  ["slot dedupe is quadratic", "convex/lib/bookingTime.ts", "out.has(start)", "[...out].includes(start)"],
  ["no steady-day fast path", "convex/lib/bookingTime.ts", "steady ? midnight + m * MINUTE :", "false ? 0 :"],
];
const lines = [];
for (const [name, file, from, to] of mutants) {
  const original = readFileSync(file, "utf8");
  if (!original.includes(from)) { lines.push(`MISSING ${name}`); continue; }
  writeFileSync(file, original.replace(from, to));
  try {
    const run = spawnSync("pnpm", ["exec", "vitest", "run", "convex/bookings.test.ts"], { encoding: "utf8" });
    const caught = run.status !== 0, failed = /Tests\s+(\d+) failed/.exec(run.stdout)?.[1] ?? "0";
    lines.push(`${caught ? "CAUGHT  " : "SURVIVED"} ${name} (${failed} failing)`);
  } finally { writeFileSync(file, original); }
  console.log(lines.at(-1));
}
writeFileSync("evidence/2026-10-03-campaigns/B/mutants.txt", lines.join("\n") + "\n");
