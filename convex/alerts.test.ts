import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { makeTest } from "./test.setup";
import { detect, notice } from "./alerts";

const evaluate = makeFunctionReference<"mutation">("alerts:evaluate");
const check = makeFunctionReference<"action">("alerts:check");
const record = makeFunctionReference<"mutation">("telemetry:record");
const start = 1_800_000_000_000;
const minute = () => Math.floor(Date.now() / 60_000);
const opens = (notices: any[], kind?: string) => notices.filter((n) => n.payload.event === "open" && (!kind || n.payload.kind === kind));
const resolves = (notices: any[], kind?: string) => notices.filter((n) => n.payload.event === "resolve" && (!kind || n.payload.kind === kind));
const allNotices = (t: any) => t.run((ctx: any) => ctx.db.query("opsNotices").collect());
// telemetry:record is a real background function; an out-of-range minute makes it throw.
const schedule = (t: any, ok: boolean) => t.run((ctx: any) => ctx.scheduler.runAfter(0, record, { minute: ok ? minute() : 0, route: "probe", status: 200, durationMs: 1, release: "unknown" }));

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); delete process.env.REMOLD_ALERT_WEBHOOK_URL; });

it("opens one alert for a failing background function, stays quiet while it keeps failing, and resolves when it succeeds", async () => {
  const t = makeTest();
  await schedule(t, false);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  await t.mutation(evaluate, { claim: false });
  expect(opens(await allNotices(t), "background-error").map((n) => n.payload.key)).toEqual(["background-error:telemetry:record"]);
  vi.advanceTimersByTime(1000);
  await schedule(t, false);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  await t.mutation(evaluate, { claim: false });
  await t.mutation(evaluate, { claim: false });
  expect(opens(await allNotices(t))).toHaveLength(1);
  expect(resolves(await allNotices(t))).toHaveLength(0);
  vi.advanceTimersByTime(1000);
  await schedule(t, true);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  await t.mutation(evaluate, { claim: false });
  await t.mutation(evaluate, { claim: false });
  const notices = await allNotices(t);
  expect(resolves(notices, "background-error")).toHaveLength(1);
  expect(opens(notices)).toHaveLength(1);
});

it("opens a REST alert for caught 500s, ignores the deliberate 503 migration pause, and resolves once the window passes", async () => {
  const t = makeTest();
  await t.mutation(record, { minute: minute(), route: "rest", status: 503, durationMs: 5, release: "unknown" });
  await t.mutation(evaluate, { claim: false });
  expect(await allNotices(t)).toEqual([]);
  await t.mutation(record, { minute: minute(), route: "rest", status: 500, durationMs: 5, release: "unknown" });
  await t.mutation(evaluate, { claim: false });
  await t.mutation(record, { minute: minute(), route: "rest", status: 500, durationMs: 5, release: "unknown" });
  await t.mutation(evaluate, { claim: false });
  expect(opens(await allNotices(t), "rest-500")).toHaveLength(1);
  vi.setSystemTime(start + 4 * 60_000);
  await t.mutation(evaluate, { claim: false });
  expect(resolves(await allNotices(t))).toHaveLength(0);
  vi.setSystemTime(start + 6 * 60_000);
  await t.mutation(evaluate, { claim: false });
  expect(resolves(await allNotices(t), "rest-500")).toHaveLength(1);
});

it("flags scheduled work that has not finished long after its start time and resolves once it runs", async () => {
  const t = makeTest();
  await schedule(t, true);
  vi.setSystemTime(start + 14 * 60_000);
  await t.mutation(evaluate, { claim: false });
  expect(await allNotices(t)).toEqual([]);
  vi.setSystemTime(start + 16 * 60_000);
  await t.mutation(evaluate, { claim: false });
  await t.mutation(evaluate, { claim: false });
  expect(opens(await allNotices(t), "stalled").map((n) => n.payload.key)).toEqual(["stalled:telemetry:record"]);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  await t.mutation(evaluate, { claim: false });
  expect(resolves(await allNotices(t), "stalled")).toHaveLength(1);
});

it("keeps error text, arguments and customer content out of every notification", () => {
  const now = start;
  const scheduled = [
    { name: "crm.js:sync", scheduledTime: now - 1000, _creationTime: now - 1000, state: { kind: "failed", error: "Uncaught Error: bad contact private.person@example.invalid token sk_live_secret" }, args: [{ email: "private.person@example.invalid", notes: "record contents" }] },
    { name: "crm.js:send", scheduledTime: now - 3_600_000, _creationTime: now - 3_600_000, state: { kind: "inProgress" }, args: [{ body: "record contents" }] },
  ];
  const conditions = detect({ scheduled, rest: [{ minute: minute(), route: "rest", status: "500", serverErrors: 1 }], now, stallMs: 60_000, windowMinutes: 5, truncated: false });
  expect(conditions.map((c) => c.kind).sort()).toEqual(["background-error", "rest-500", "stalled"]);
  const text = JSON.stringify(conditions.flatMap((c) => [notice("open", c, now), notice("resolve", c, now)]));
  for (const secret of ["example.invalid", "sk_live", "record contents", "Uncaught", "bad contact"]) expect(text).not.toContain(secret);
});

it("reports a truncated scan as its own alert instead of silently checking less", () => {
  expect(detect({ scheduled: [], rest: [], now: start, stallMs: 60_000, windowMinutes: 5, truncated: true }).map((c) => c.key)).toEqual(["coverage"]);
});

it("delivers each notice to the configured sink, retries failed deliveries, and never resends a delivered one", async () => {
  const t = makeTest();
  await t.mutation(record, { minute: minute(), route: "rest", status: 500, durationMs: 5, release: "unknown" });
  const sent: any[] = [];
  let up = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response(null, { status: up ? 204 : 503 }); }));
  expect(await t.action(check, {})).toEqual({ delivered: 0, undelivered: 1, channel: "unconfigured" });
  process.env.REMOLD_ALERT_WEBHOOK_URL = "http://alerts.example.invalid/hook";
  expect((await t.action(check, {})).channel).toBe("unconfigured");
  expect(sent).toEqual([]);
  process.env.REMOLD_ALERT_WEBHOOK_URL = "http://127.0.0.1:9/hook";
  expect(await t.action(check, {})).toEqual({ delivered: 0, undelivered: 1, channel: "configured" });
  up = true;
  expect(await t.action(check, {})).toEqual({ delivered: 1, undelivered: 0, channel: "configured" });
  expect(await t.action(check, {})).toEqual({ delivered: 0, undelivered: 0, channel: "configured" });
  expect(sent).toHaveLength(2);
  expect(sent[1].body).toMatchObject({ source: "remold", event: "open", kind: "rest-500", key: "rest-500", count: 1 });
  expect(sent[0].body.id).toBe(sent[1].body.id);
});

it("sends a notice once even when two checks overlap", async () => {
  const t = makeTest();
  await t.mutation(record, { minute: minute(), route: "rest", status: 500, durationMs: 5, release: "unknown" });
  process.env.REMOLD_ALERT_WEBHOOK_URL = "http://127.0.0.1:9/hook";
  const sent: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => { sent.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }));
  await Promise.all([t.action(check, {}), t.action(check, {})]);
  await t.action(check, {});
  expect(sent.map((n) => n.key)).toEqual(["rest-500"]);
});
