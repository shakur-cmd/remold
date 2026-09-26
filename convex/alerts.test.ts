import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { makeTest } from "./test.setup";
import { channel, conditions, notice } from "./alerts";

const check = makeFunctionReference<"action">("alerts:check");
const record = makeFunctionReference<"mutation">("telemetry:record");
const start = 1_800_000_000_000;
const minute = () => Math.floor(Date.now() / 60_000);
const opens = (notices: any[], kind?: string) => notices.filter((n) => n.payload.event === "open" && (!kind || n.payload.kind === kind));
const resolves = (notices: any[], kind?: string) => notices.filter((n) => n.payload.event === "resolve" && (!kind || n.payload.kind === kind));
const allNotices = (t: any) => t.run((ctx: any) => ctx.db.query("opsNotices").collect());
// telemetry:record is a real background function; an out-of-range minute makes it throw.
const schedule = (t: any, ok: boolean, delay = 0, release = "unknown") => t.run((ctx: any) => ctx.scheduler.runAfter(delay, record, { minute: ok ? minute() : 0, route: "probe", status: 200, durationMs: 1, release }));
const run = (t: any) => t.finishAllScheduledFunctions(vi.runAllTimers);
// Checks scan only rows older than the 10s commit lag, so step past it first.
const later = (t: any, ms = 11_000) => { vi.setSystemTime(Date.now() + ms); return t.action(check, {}); };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); delete process.env.REMOLD_ALERT_WEBHOOK_URL; });

it("opens one alert for a failing background function, stays quiet while it keeps failing, and resolves when it succeeds", async () => {
  const t = makeTest();
  await schedule(t, false); await run(t);
  await later(t);
  expect(opens(await allNotices(t), "background-error").map((n) => n.payload.key)).toEqual(["background-error:telemetry:record"]);
  await schedule(t, false); await run(t);
  await later(t); await later(t);
  expect(opens(await allNotices(t))).toHaveLength(1);
  expect(resolves(await allNotices(t))).toHaveLength(0);
  await schedule(t, true); await run(t);
  await later(t); await later(t);
  const notices = await allNotices(t);
  expect(resolves(notices, "background-error")).toHaveLength(1);
  expect(opens(notices)).toHaveLength(1);
});

it("opens a REST alert for caught 500s, ignores the deliberate 503 migration pause, and resolves once the window passes", async () => {
  const t = makeTest();
  await t.mutation(record, { minute: minute(), route: "rest", status: 503, durationMs: 5, release: "unknown" });
  await t.action(check, {});
  expect(await allNotices(t)).toEqual([]);
  await t.mutation(record, { minute: minute(), route: "rest", status: 500, durationMs: 5, release: "unknown" });
  await t.action(check, {});
  await t.mutation(record, { minute: minute(), route: "rest", status: 500, durationMs: 5, release: "unknown" });
  await t.action(check, {});
  expect(opens(await allNotices(t), "rest-500")).toHaveLength(1);
  vi.setSystemTime(start + 4 * 60_000);
  await t.action(check, {});
  expect(resolves(await allNotices(t))).toHaveLength(0);
  vi.setSystemTime(start + 6 * 60_000);
  await t.action(check, {});
  expect(resolves(await allNotices(t), "rest-500")).toHaveLength(1);
});

it("flags work unfinished 15 minutes after it was due and keeps the alert open until the job actually runs", async () => {
  const t = makeTest();
  await schedule(t, true);
  await later(t, 14 * 60_000);
  expect(await allNotices(t)).toEqual([]);
  await later(t, 2 * 60_000);
  await later(t);
  expect(opens(await allNotices(t), "stalled").map((n) => n.payload.key)).toEqual(["stalled:telemetry:record"]);
  for (const step of [45 * 60_000, 2 * 60 * 60_000]) await later(t, step);
  expect(resolves(await allNotices(t))).toHaveLength(0);
  await run(t);
  await later(t);
  expect(resolves(await allNotices(t), "stalled")).toHaveLength(1);
});

it("measures a stall from when a job was due, including jobs scheduled far ahead", async () => {
  const t = makeTest();
  await schedule(t, true, 30 * 60_000);
  await later(t, 20 * 60_000);
  expect(await allNotices(t)).toEqual([]);
  const u = makeTest();
  vi.setSystemTime(start);
  await schedule(u, true, 50 * 60_000);
  await later(u, 60_000);
  await later(u, 69 * 60_000);
  expect(opens(await allNotices(u), "stalled")).toHaveLength(1);
});

it("keeps error text, arguments and customer content out of every notification", async () => {
  const t = makeTest();
  await schedule(t, false, 0, "private.person@example.invalid sk_live_secret record contents"); await run(t);
  await later(t);
  const stored = JSON.stringify(await allNotices(t)) + JSON.stringify(await t.run((ctx: any) => ctx.db.query("opsAlerts").collect()));
  expect(opens(await allNotices(t))).toHaveLength(1);
  const built = JSON.stringify(conditions({ health: [{ fn: "crm:sync", lastAt: start, lastFailed: true, failures: 2 }], stalled: [{ fn: "crm:send", count: 1 }], restErrors: 3, behind: true, now: start }).flatMap((c) => [notice("open", c, start), notice("resolve", c, start)]));
  for (const secret of ["example.invalid", "sk_live", "record contents"]) { expect(stored).not.toContain(secret); expect(built).not.toContain(secret); }
});

it("raises a coverage alert when a check cannot scan everything and resolves once caught up", async () => {
  const t = makeTest();
  await t.run(async (ctx: any) => { for (let i = 0; i < 2500; i++) await ctx.scheduler.runAfter(60 * 60_000, record, { minute: 0, route: "probe", status: 200, durationMs: 1, release: "unknown" }); });
  const first = await later(t);
  expect(first.behind).toBe(true);
  expect(opens(await allNotices(t), "coverage")).toHaveLength(1);
  const second = await later(t);
  expect(second.behind).toBe(false);
  expect(resolves(await allNotices(t), "coverage")).toHaveLength(1);
});

it("treats a large backlog of recently due jobs as normal lag, but an unreadable list of overdue jobs as behind", async () => {
  const t = makeTest();
  await t.run(async (ctx: any) => { for (let i = 0; i < 1100; i++) await ctx.scheduler.runAfter(0, record, { minute: 0, route: "probe", status: 200, durationMs: 1, release: "unknown" }); });
  expect((await later(t)).behind).toBe(false);
  expect((await later(t)).behind).toBe(false);
  const overdue = await later(t, 16 * 60_000);
  expect(overdue.behind).toBe(true);
  expect(opens(await allNotices(t), "stalled")).toHaveLength(1);
});

it("holds the REST alert open and raises coverage when the REST window is too large to read", async () => {
  const t = makeTest();
  await t.mutation(record, { minute: minute(), route: "rest", status: 500, durationMs: 5, release: "unknown" });
  await t.action(check, {});
  vi.setSystemTime(start + 7 * 60_000);
  await t.run(async (ctx: any) => { for (let i = 0; i < 3000; i++) await ctx.db.insert("opsMetrics", { minute: minute(), route: "probe", status: "200", release: "unknown", count: 1, serverErrors: 0, clientErrors: 0, sumMs: 1, maxMs: 1, buckets: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }); });
  expect((await t.action(check, {})).behind).toBe(true);
  const notices = await allNotices(t);
  expect(resolves(notices, "rest-500")).toHaveLength(0);
  expect(opens(notices, "coverage")).toHaveLength(1);
});

it("never creates a second alert row or open notice when checks overlap", async () => {
  const t = makeTest();
  await t.mutation(record, { minute: minute(), route: "rest", status: 500, durationMs: 5, release: "unknown" });
  const results = await Promise.all(Array.from({ length: 6 }, () => t.action(check, {})));
  expect(results.filter((r: any) => r.applied)).toHaveLength(1);
  const rows: any[] = await t.run((ctx: any) => ctx.db.query("opsAlerts").collect());
  expect(rows.filter((a) => a.key === "rest-500")).toHaveLength(1);
  expect(opens(await allNotices(t))).toHaveLength(1);
});

it("deletes notices older than seven days, delivered or not", async () => {
  const t = makeTest();
  await t.mutation(record, { minute: minute(), route: "rest", status: 500, durationMs: 5, release: "unknown" });
  await t.action(check, {});
  vi.setSystemTime(start + 7 * 24 * 60 * 60_000 + 60_000);
  await t.action(check, {});
  expect((await allNotices(t)).map((n: any) => n.payload.event)).toEqual(["resolve"]);
});

it("accepts HTTPS to public hosts and plain HTTP only to exactly 127.0.0.1 or localhost", () => {
  for (const good of ["https://hooks.example.com/x", "http://127.0.0.1:9/x", "http://localhost:9/x", "http://127.1:9/x"]) expect(channel(good), good).not.toBeNull();
  for (const bad of ["http://0.0.0.0:9/x", "http://[::1]:9/x", "http://localhost.evil.test/x", "http://hooks.example.com/x", "ftp://127.0.0.1/x", "ftp://hooks.example.com/x", "file:///etc/passwd", "ws://hooks.example.com/x",
    "https://169.254.169.254/latest", "https://10.0.0.1/x", "https://172.16.0.1/x", "https://192.168.1.1/x", "https://127.0.0.1/x", "https://localhost/x", "https://[::1]/x", "https://[fd00::1]/x", "https://metadata.internal/x", "", "not a url"]) expect(channel(bad), bad).toBeNull();
});

it("delivers each notice to the configured sink, retries failed deliveries, and never resends a delivered one", async () => {
  const t = makeTest();
  await t.mutation(record, { minute: minute(), route: "rest", status: 500, durationMs: 5, release: "unknown" });
  const sent: any[] = [];
  let up = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response(null, { status: up ? 204 : 503 }); }));
  expect((await t.action(check, {})).channel).toBe("unconfigured");
  process.env.REMOLD_ALERT_WEBHOOK_URL = "http://alerts.example.invalid/hook";
  expect((await t.action(check, {})).channel).toBe("unconfigured");
  expect(sent).toEqual([]);
  process.env.REMOLD_ALERT_WEBHOOK_URL = "http://127.0.0.1:9/hook";
  expect((await t.action(check, {})).delivered).toBe(0);
  up = true;
  expect((await t.action(check, {})).delivered).toBe(1);
  expect((await t.action(check, {})).delivered).toBe(0);
  expect(sent).toHaveLength(2);
  expect(sent[1].body).toMatchObject({ source: "remold", event: "open", kind: "rest-500", key: "rest-500", count: 1 });
  expect(sent[0].body.id).toBe(sent[1].body.id);
});

it("sends each notice once when checks overlap, even behind a sink slower than a minute", async () => {
  const t = makeTest();
  await t.mutation(record, { minute: minute(), route: "rest", status: 500, durationMs: 5, release: "unknown" });
  await t.action(check, {});
  vi.setSystemTime(start + 7 * 60_000);
  await t.action(check, {});
  expect(await allNotices(t)).toHaveLength(2);
  process.env.REMOLD_ALERT_WEBHOOK_URL = "http://127.0.0.1:9/hook";
  const sent: string[] = [];
  let nested = false;
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: any) => {
    sent.push(JSON.parse(init.body).id);
    if (!nested) { nested = true; vi.setSystemTime(Date.now() + 70_000); await t.action(check, {}); }
    return new Response(null, { status: 204 });
  }));
  await Promise.all([t.action(check, {}), t.action(check, {})]);
  await t.action(check, {});
  expect(sent).toHaveLength(2);
  expect(new Set(sent).size).toBe(2);
});

it("does not follow a redirect away from the configured sink", async () => {
  vi.useRealTimers();
  const landed: string[] = [];
  const target = createServer((req, res) => { landed.push(req.url ?? ""); res.writeHead(204).end(); });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  const hop = createServer((_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/landed` }).end(); });
  await new Promise<void>((r) => hop.listen(0, "127.0.0.1", r));
  try {
    const t = makeTest();
    await t.mutation(record, { minute: minute(), route: "rest", status: 500, durationMs: 5, release: "unknown" });
    process.env.REMOLD_ALERT_WEBHOOK_URL = `http://127.0.0.1:${(hop.address() as AddressInfo).port}/hook`;
    expect((await t.action(check, {})).delivered).toBe(0);
    expect(landed).toEqual([]);
  } finally { target.close(); hop.close(); }
});
