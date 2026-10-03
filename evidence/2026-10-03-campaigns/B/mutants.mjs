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
  ["slot not re-checked on book", "convex/bookings.ts", "if (!(await isOpen(ctx, page, a.start, now, own?._id))) return { status: \"taken\" as const };", ""],
  ["live not required", "convex/lib/booking.ts", "|| value(record, item.f.live) !== true", ""],
  ["missing cap allowed", "convex/lib/booking.ts", "if (!record || dailyCap() === 0) return null;", "if (!record) return null;"],
  ["readonly allowed", "convex/lib/booking.ts", "org.flags?.readonly || !item ||", "!item ||"],
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
  ["paid confirms an owner-cancelled booking", "convex/bookings.ts", ": owned ? \"Paid, but the booking was cancelled\"", ": false ? \"\""],
  ["underpayment confirms", "convex/bookings.ts", "|| a.amountMinor < min)", "|| false)"],
  ["other currency confirms", "convex/bookings.ts", "(a.currency !== asked || ", "(false || "],
  ["zero-decimal currencies divided by 100", "convex/lib/bookingTime.ts", "ZERO_DECIMAL.has(currency.toLowerCase()) ? 1 : 100", "100"],
  ["async success ignored", "convex/bookings.ts", " || type === \"checkout.session.async_payment_succeeded\"", ""],
  ["async failure ignored", "convex/bookings.ts", "if (type === \"checkout.session.async_payment_failed\") await ctx.runMutation(internal.bookings.failed, ids);", ""],
  ["livemode not recorded", "convex/bookings.ts", ", livemode: a.livemode });", " });"],
  ["probing not metered", "convex/bookings.ts", "if (!perPage.ok) return limited(perPage.retryAfter ?? 0);", ""],
  ["holds count against the daily cap", "convex/bookings.ts", "await limiter.check(ctx, \"bookingDaily\"", "await limiter.limit(ctx, \"bookingDaily\""],
  ["no limit on holds per page", "convex/bookings.ts", "if (holds.length >= HOLDS_PER_PAGE) return", "if (false) return"],
  ["webhook not rate limited", "convex/bookings.ts", "if (!allowed) return new Response(\"Too many requests\"", "if (false) return new Response(\"Too many requests\""],
  ["stale booking link sends", "convex/lib/campaign.ts", "if (links.problem) problems.push(links.problem);", ""],
  ["linked pages not in the content version", "convex/lib/campaign.ts", "...(pages.length ? { pages } : {})", ""],
  ["repeated local time gets the later instant", "convex/lib/bookingTime.ts", "Math.min(...found)", "Math.max(...found)"],
  ["slot dedupe is quadratic", "convex/lib/bookingTime.ts", "out.has(start)", "[...out].includes(start)"],
  ["no steady-day fast path", "convex/lib/bookingTime.ts", "steady ? midnight + m * MINUTE :", "false ? 0 :"],
  // Round 3.
  ["paid page without currency allowed", "convex/lib/booking.ts", "if (link !== null && set(\"currency\") === null && (changed(\"paymentLink\") || changed(\"currency\"))) fail(", "if (false) fail("],
  ["automation may set live", "convex/lib/automation.ts", "if (item.object.key === \"bookingPage\" && key === \"live\") bad(", "if (false) bad("],
  ["another time adds a second hold", "convex/bookings.ts", "  if (own) {\n", "  if (own && false) {\n"],
  ["attention frees the time", "convex/bookings.ts", "if (short && !owned && free) await ctx.db.patch(", "if (false) await ctx.db.patch("],
  ["attention hold runs out", "convex/bookings.ts", "holdUntil: Number.MAX_SAFE_INTEGER,", "holdUntil: now,"],
  ["any member resolves", "convex/bookings.ts", "requireWriter(ctx, args.orgId, \"admin\"), b = await ctx.db.get(args.bookingId)", "requireWriter(ctx, args.orgId), b = await ctx.db.get(args.bookingId)"],
  ["confirm anyway over a taken time", "convex/bookings.ts", ".some((x) => x.start < b.end && b.start < x.end)) fail(\"CONFLICT\", \"That time", ".some((x) => false)) fail(\"CONFLICT\", \"That time"],
  ["confirm anyway not on the timeline", "convex/bookings.ts", "await logActivity(ctx, b.orgId, b.personRecordId, `Confirmed anyway by", "if (false) await logActivity(ctx, b.orgId, b.personRecordId, `Confirmed anyway by"],
  ["release not on the timeline", "convex/bookings.ts", "`Released by ${who}, refund in Stripe: ${b.attention}`", "`Released`"],
  ["resolve without a decision pending", "convex/bookings.ts", "if (!b.attention) fail(\"CONFLICT\", \"This booking needs no decision\");", ""],
  ["members see the decision buttons", "convex/bookings.ts", "!!b.attention && principal.member.role !== \"member\"", "!!b.attention"],
  ["webhook limits unknown ids", "convex/bookings.ts", "  if (!id || !(await ctx.db.get(id))) return null;\n  return (await limiter.limit(ctx, \"stripeHook\", { key: id })).ok;", "  return (await limiter.limit(ctx, \"stripeHook\", { key: orgId.slice(0, 64) })).ok;"],
  // Round 4.
  ["a move renews the hold", "convex/bookings.ts", "await ctx.db.patch(own._id, { pageRecordId", "await ctx.db.patch(own._id, { holdUntil: now + HOLD, pageRecordId"],
  ["an address with a payment waiting gets a second hold", "convex/bookings.ts", "if (mine.some((b) => b.attention)) fail(", "if (false) fail("],
  ["a paid page without a currency takes bookings", "convex/lib/booking.ts", "if (typeof value(record, item.f.paymentLink) === \"string\" && typeof value(record, item.f.currency) !== \"string\") return null;", ""],
  ["a released payment stays in revenue", "convex/lib/booking.ts", "&& !released.includes(b))", ")"],
  ["a refund due is not reported", "convex/lib/booking.ts", "refundDue: sum(released)", "refundDue: []"],
];
const lines = [];
const [lo = 0, hi = mutants.length] = process.argv.slice(2).map(Number);
for (const [name, file, from, to] of mutants.slice(lo, hi)) {
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
writeFileSync(`evidence/2026-10-03-campaigns/B/mutants-${lo}-${hi}.txt`, lines.join("\n") + "\n");
