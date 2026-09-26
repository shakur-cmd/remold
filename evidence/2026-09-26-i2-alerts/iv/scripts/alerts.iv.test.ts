// Independent verifier attacks on convex/alerts.ts (a173192). Not builder tests.
// Each test states the behavior it probes; "DEFECT" tests assert the bad behavior
// actually happens, so they pass while the defect exists.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { makeTest } from "./test.setup";
import { channel } from "./alerts";

const evaluate = makeFunctionReference<"mutation">("alerts:evaluate");
const check = makeFunctionReference<"action">("alerts:check");
const record = makeFunctionReference<"mutation">("telemetry:record");
const start = 1_800_000_000_000;
const minute = () => Math.floor(Date.now() / 60_000);
const all = (t: any) => t.run((ctx: any) => ctx.db.query("opsNotices").collect());
const alerts = (t: any) => t.run((ctx: any) => ctx.db.query("opsAlerts").collect());
const schedule = (t: any, ok: boolean, delay = 0) => t.run((ctx: any) => ctx.scheduler.runAfter(delay, record, { minute: ok ? minute() : 0, route: "probe", status: 200, durationMs: 1, release: "unknown" }));

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); delete process.env.REMOLD_ALERT_WEBHOOK_URL; });

it("channel rule: which URLs are accepted", () => {
  const table = Object.fromEntries([
    "https://hooks.example.com/x", "http://127.0.0.1:9/x", "http://localhost:9/x", "http://127.1:9/x", "http://2130706433:9/x",
    "http://user:pw@127.0.0.1:9/x", "http://localhost.:9/x", "http://[::1]:9/x", "http://0.0.0.0:9/x", "http://127.0.0.1.nip.io/x",
    "http://localhost.evil.test/x", "http://127.0.0.1@evil.test/x", "http://evil.test#@127.0.0.1/x", "https://169.254.169.254/latest", "https://10.0.0.1/x",
    "ftp://127.0.0.1/x", "file:///etc/passwd", "javascript:alert(1)", "", "not a url",
  ].map((u) => [u, channel(u)]));
  console.log("IV channel table", JSON.stringify(table, null, 1));
  // Plain HTTP is loopback only (after WHATWG normalization).
  expect(table["http://127.1:9/x"]).toBe("http://127.0.0.1:9/x");
  expect(table["http://2130706433:9/x"]).toBe("http://127.0.0.1:9/x");
  for (const bad of ["http://localhost.:9/x", "http://[::1]:9/x", "http://0.0.0.0:9/x", "http://127.0.0.1.nip.io/x", "http://localhost.evil.test/x", "http://127.0.0.1@evil.test/x", "http://evil.test#@127.0.0.1/x", "ftp://127.0.0.1/x", "file:///etc/passwd", "javascript:alert(1)", "", "not a url"]) expect(table[bad], bad).toBeNull();
  // HTTPS to any host, including private and link-local addresses, is accepted.
  expect(table["https://169.254.169.254/latest"]).not.toBeNull();
  expect(table["https://10.0.0.1/x"]).not.toBeNull();
});

it("fetch follows redirects by default, so the loopback-only rule does not bind the final destination", async () => {
  const t = makeTest();
  await t.mutation(record, { minute: minute(), route: "rest", status: 500, durationMs: 5, release: "unknown" });
  process.env.REMOLD_ALERT_WEBHOOK_URL = "http://127.0.0.1:9/hook";
  const inits: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => { inits.push(init); return new Response(null, { status: 204 }); }));
  await t.action(check, {});
  expect(inits).toHaveLength(1);
  // DEFECT (low): no redirect: "manual"/"error", so a 307 to http://evil would be followed with the body.
  expect(inits[0].redirect).toBeUndefined();
});

it("concurrent evaluations never create a second alert row or a second open notice", async () => {
  const t = makeTest();
  await t.mutation(record, { minute: minute(), route: "rest", status: 500, durationMs: 5, release: "unknown" });
  await Promise.all(Array.from({ length: 8 }, () => t.mutation(evaluate, { claim: false })));
  expect((await alerts(t)).filter((a: any) => a.key === "rest-500")).toHaveLength(1);
  expect((await all(t)).filter((n: any) => n.payload.event === "open")).toHaveLength(1);
});

it("flapping fault: every open and every resolve queues a notice, with no hysteresis", async () => {
  const t = makeTest();
  for (let i = 0; i < 5; i++) {
    await schedule(t, false); await t.finishAllScheduledFunctions(vi.runAllTimers); await t.mutation(evaluate, { claim: false });
    vi.advanceTimersByTime(1000);
    await schedule(t, true); await t.finishAllScheduledFunctions(vi.runAllTimers); await t.mutation(evaluate, { claim: false });
    vi.advanceTimersByTime(1000);
  }
  const n = await all(t);
  expect(n.filter((x: any) => x.payload.event === "open")).toHaveLength(5);
  expect(n.filter((x: any) => x.payload.event === "resolve")).toHaveLength(5);
  expect(await alerts(t)).toHaveLength(1);
});

it("undelivered notices with no channel are kept 7 days and then deleted (bounded by age, not count)", async () => {
  const t = makeTest();
  await t.mutation(record, { minute: minute(), route: "rest", status: 500, durationMs: 5, release: "unknown" });
  await t.mutation(evaluate, { claim: false });
  expect(await all(t)).toHaveLength(1);
  vi.setSystemTime(start + 7 * 24 * 60 * 60_000 + 60_000);
  await t.mutation(evaluate, { claim: false });
  const left = await all(t);
  // The 7-day-old undelivered open notice is gone; only the new resolve remains.
  expect(left.map((n: any) => n.payload.event)).toEqual(["resolve"]);
});

it("DEFECT: a stall still pending past the 60 minute lookback is reported as resolved", async () => {
  const t = makeTest();
  await schedule(t, true); // never run: stays pending
  vi.setSystemTime(start + 16 * 60_000);
  await t.mutation(evaluate, { claim: false });
  vi.setSystemTime(start + 61 * 60_000);
  await t.mutation(evaluate, { claim: false });
  const state = await t.run((ctx: any) => ctx.db.system.query("_scheduled_functions").collect());
  expect(state.map((r: any) => r.state.kind)).toEqual(["pending"]);
  const n = await all(t);
  expect(n.map((x: any) => `${x.payload.event}:${x.payload.key}`)).toEqual(["open:stalled:telemetry:record", "resolve:stalled:telemetry:record"]);
});

it("DEFECT (latent): a job scheduled more than ~45 minutes ahead is never seen as stalled", async () => {
  const t = makeTest();
  await schedule(t, true, 50 * 60_000);
  vi.setSystemTime(start + 70 * 60_000); // 20 minutes overdue, never ran
  await t.mutation(evaluate, { claim: false });
  expect(await all(t)).toEqual([]);
});

it("DEFECT (low): a slow sink lets an overlapping check resend a notice after the 60s claim lapses", async () => {
  const t = makeTest();
  await t.mutation(record, { minute: minute(), route: "rest", status: 500, durationMs: 5, release: "unknown" });
  await t.mutation(evaluate, { claim: false });
  vi.setSystemTime(start + 7 * 60_000); // rest-500 resolves: a second notice
  await t.mutation(evaluate, { claim: false });
  expect(await all(t)).toHaveLength(2);
  process.env.REMOLD_ALERT_WEBHOOK_URL = "http://127.0.0.1:9/hook";
  const sent: string[] = [];
  let nested = false;
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
    const body = JSON.parse(init.body);
    sent.push(body.id);
    if (!nested) { nested = true; vi.setSystemTime(Date.now() + 70_000); await t.action(check, {}); } // first send takes 70s; a manual check runs meanwhile
    return new Response(null, { status: 204 });
  }));
  await t.action(check, {});
  console.log("IV slow-sink sends", sent);
  expect(sent.length).toBeGreaterThan(new Set(sent).size);
});
