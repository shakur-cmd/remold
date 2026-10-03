// Breaks one booking rule at a time and runs convex/bookings.test.ts; each mutant must be caught.
// Run from the repo root: node evidence/2026-10-03-campaigns/B/mutants.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const mutants = [
  ["notice ignored", "convex/lib/bookingTime.ts", "earliest = now + rules.noticeHours * HOUR", "earliest = now"],
  ["horizon ignored", "convex/lib/bookingTime.ts", "start > latest ||", ""],
  ["zone ignored (UTC wall clock)", "convex/lib/bookingTime.ts", "const start = instantOf(day + m * MINUTE, rules.timezone);", "const start = day + m * MINUTE;"],
  ["busy ignored", "convex/lib/bookingTime.ts", "if (!busy.some((b) => b.start < start + length && start < b.end)) out.push(start);", "out.push(start);"],
  ["expired holds still block", "convex/lib/booking.ts", "(b.holdUntil ?? 0) > now", "true"],
  ["meetings ignored", "convex/lib/booking.ts", "value(r, activity.f.type) === \"meeting\"", "false"],
  ["slot not re-checked on book", "convex/bookings.ts", "if (!(await isOpen(ctx, page, a.start, now))) return { status: \"taken\" as const };", ""],
  ["live not required", "convex/lib/booking.ts", "|| value(record, item.f.live) !== true", ""],
  ["missing cap allowed", "convex/lib/booking.ts", "if (!record || dailyCap() === 0) return null;", "if (!record) return null;"],
  ["readonly allowed", "convex/lib/booking.ts", "org.flags?.readonly || ", ""],
  ["existing person updated", "convex/lib/booking.ts", "if (byEmail) return byEmail._id;", "if (byEmail) { await ctx.db.patch(byEmail._id, { title: name }); return byEmail._id; }"],
  ["signature not checked", "convex/bookings.ts", "if (!(await verifyStripe(found.secret, request.headers.get(\"stripe-signature\"), body, Date.now())))", "if (false)"],
  ["stale timestamp allowed", "convex/lib/bookingTime.ts", "|| Math.abs(now / 1000 - Number(t)) > 300", ""],
  ["other org's booking accepted", "convex/bookings.ts", "if (!booking || booking.orgId !== a.orgId || booking.paidAt) return;", "if (!booking || booking.paidAt) return;"],
  ["unpaid accepted", "convex/bookings.ts", "&& session.payment_status === \"paid\"", ""],
  ["paid confirms even when taken", "convex/bookings.ts", "if (free) return confirm(", "if (true) return confirm("],
  ["agents may publish", "convex/authority/agentGuards.ts", "if (field === live && to === true)", "if (false)"],
  ["send attribution dropped", "convex/bookings.ts", "...(from ? { sendId: from._id } : {}), ", ""],
  ["public page leaks the payment link", "convex/bookings.ts", "paid: !!page.paymentLink,", "paid: !!page.paymentLink, link: page.paymentLink,"],
  ["honeypot ignored", "convex/bookings.ts", "if (a.website?.trim()) return { status: \"confirmed\" as const };", ""],
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
