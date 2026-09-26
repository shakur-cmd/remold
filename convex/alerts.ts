declare const process: { env: Record<string, string | undefined> };
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

// Operator alerts: a cron evaluates recent operational facts, opens one alert per
// condition key, and queues one notification per open and per resolve. Delivery
// is at-least-once to REMOLD_ALERT_WEBHOOK_URL; each notice carries its id.
export type Kind = "background-error" | "rest-500" | "stalled" | "coverage";
export type Condition = { key: string; kind: Kind; fn?: string; count: number };
type ScheduledRow = { name: string; scheduledTime: number; _creationTime: number; state: { kind: string } };
type RestRow = { minute: number; route: string; status: string; serverErrors: number };

// CLAIM_MS exceeds the 10s send timeout, so a claim outlives any send attempt.
const LOOKBACK_MS = 60 * 60_000, SCAN_CAP = 5000, RETAIN_MS = 7 * 24 * 60 * 60_000, CLAIM_MS = 60_000;
const setting = (name: string, fallback: number, min: number, max: number) => {
  const n = Number(process.env[name]);
  return process.env[name] && Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

export function detect(input: { scheduled: ScheduledRow[]; rest: RestRow[]; now: number; stallMs: number; windowMinutes: number; truncated: boolean }): Condition[] {
  const found = new Map<string, Condition>();
  const add = (kind: Kind, fn?: string, count = 1) => {
    const key = fn ? `${kind}:${fn}` : kind;
    const condition = found.get(key) ?? { key, kind, ...(fn ? { fn } : {}), count: 0 };
    condition.count += count;
    found.set(key, condition);
  };
  const latest = new Map<string, ScheduledRow>(), failures = new Map<string, number>();
  for (const row of input.scheduled) {
    const fn = row.name.replace(/\.js:/, ":"), state = row.state.kind;
    if ((state === "pending" || state === "inProgress") && row.scheduledTime < input.now - input.stallMs) add("stalled", fn);
    if (state === "failed") failures.set(fn, (failures.get(fn) ?? 0) + 1);
    if (state !== "success" && state !== "failed") continue;
    const previous = latest.get(fn);
    if (!previous || row.scheduledTime > previous.scheduledTime || (row.scheduledTime === previous.scheduledTime && row._creationTime > previous._creationTime)) latest.set(fn, row);
  }
  // A background function is failing while its most recent finished run failed.
  for (const [fn, row] of latest) if (row.state.kind === "failed") add("background-error", fn, failures.get(fn));
  // Only status 500 is a caught internal error; 503 is the deliberate migration pause.
  const since = Math.floor(input.now / 60_000) - input.windowMinutes;
  const errors = input.rest.filter((r) => r.route === "rest" && r.status === "500" && r.minute >= since).reduce((n, r) => n + r.serverErrors, 0);
  if (errors) add("rest-500", undefined, errors);
  if (input.truncated) add("coverage", undefined, SCAN_CAP);
  return [...found.values()];
}

// Notifications are built only from the kind, a code-defined function name and
// counts. Error text, arguments, URLs and headers never reach this function.
export function notice(event: "open" | "resolve", c: Condition, at: number) {
  const subject = {
    "background-error": `Background function ${c.fn} is failing`,
    "rest-500": "REST API is returning internal errors (500)",
    stalled: `Scheduled function ${c.fn} is stalled`,
    coverage: "Alert scan hit its row limit, so some scheduled work was not checked",
  }[c.kind];
  return { source: "remold" as const, event, kind: c.kind, key: c.key, count: c.count, at: new Date(at).toISOString(), summary: event === "open" ? `${subject} (${c.count} seen).` : `Resolved: ${subject.replace(" is ", " was ")}.` };
}

type Pending = { id: Id<"opsNotices">; payload: ReturnType<typeof notice> };

export const evaluate = internalMutation({
  args: { claim: v.boolean() },
  handler: async (ctx, args): Promise<Pending[]> => {
    const now = Date.now(), minute = Math.floor(now / 60_000);
    const stallMs = setting("REMOLD_ALERT_STALL_MS", 15 * 60_000, 1000, LOOKBACK_MS);
    const windowMinutes = setting("REMOLD_ALERT_WINDOW_MINUTES", 5, 1, 60);
    const scheduled = await ctx.db.system.query("_scheduled_functions").withIndex("by_creation_time", (q) => q.gte("_creationTime", now - LOOKBACK_MS)).order("desc").take(SCAN_CAP);
    const rest = await ctx.db.query("opsMetrics").withIndex("by_minute", (q) => q.gte("minute", minute - windowMinutes)).collect();
    const found = detect({ scheduled, rest, now, stallMs, windowMinutes, truncated: scheduled.length === SCAN_CAP });
    const open = await ctx.db.query("opsAlerts").withIndex("by_state", (q) => q.eq("state", "open")).collect();
    for (const c of found) {
      const current = open.find((a) => a.key === c.key);
      if (current) { await ctx.db.patch(current._id, { count: c.count }); continue; }
      const row = await ctx.db.query("opsAlerts").withIndex("by_key", (q) => q.eq("key", c.key)).unique();
      const data = { key: c.key, kind: c.kind, ...(c.fn ? { fn: c.fn } : {}), count: c.count, state: "open" as const, openedAt: now };
      if (row) await ctx.db.replace(row._id, data); else await ctx.db.insert("opsAlerts", data);
      await ctx.db.insert("opsNotices", { payload: notice("open", c, now), attempts: 0 });
    }
    for (const alert of open) {
      if (found.some((c) => c.key === alert.key)) continue;
      await ctx.db.patch(alert._id, { state: "resolved", resolvedAt: now });
      await ctx.db.insert("opsNotices", { payload: notice("resolve", { key: alert.key, kind: alert.kind, fn: alert.fn, count: alert.count }, now), attempts: 0 });
    }
    for (const old of await ctx.db.query("opsNotices").withIndex("by_creation_time", (q) => q.lt("_creationTime", now - RETAIN_MS)).take(100)) await ctx.db.delete(old._id);
    // Claim before sending so an overlapping check (cron plus manual run) cannot send the same notice twice.
    const claimable = (await ctx.db.query("opsNotices").withIndex("by_pending", (q) => q.eq("deliveredAt", undefined)).take(100)).filter((n) => (n.claimedUntil ?? 0) <= now).slice(0, 20);
    if (args.claim) for (const n of claimable) await ctx.db.patch(n._id, { claimedUntil: now + CLAIM_MS });
    return claimable.map((n) => ({ id: n._id, payload: n.payload }));
  },
});

export const settle = internalMutation({
  args: { id: v.id("opsNotices"), delivered: v.boolean() },
  handler: async (ctx, { id, delivered }) => {
    const row = await ctx.db.get(id);
    if (!row || row.deliveredAt !== undefined) return;
    await ctx.db.patch(id, delivered ? { deliveredAt: Date.now(), attempts: row.attempts + 1 } : { attempts: row.attempts + 1, claimedUntil: undefined });
  },
});

// Plain HTTP is only accepted for a loopback sink used in local rehearsals.
export function channel(raw = process.env.REMOLD_ALERT_WEBHOOK_URL): string | null {
  try {
    const url = new URL(raw ?? "");
    return url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)) ? url.href : null;
  } catch { return null; }
}

export const check = internalAction({
  args: {},
  handler: async (ctx): Promise<{ delivered: number; undelivered: number; channel: "configured" | "unconfigured" }> => {
    const url = channel();
    const pending: Pending[] = await ctx.runMutation(internal.alerts.evaluate, { claim: url !== null });
    if (!url) return { delivered: 0, undelivered: pending.length, channel: "unconfigured" };
    let delivered = 0;
    for (const { id, payload } of pending) {
      let ok = false;
      try { ok = (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, ...payload }), signal: AbortSignal.timeout(10_000) })).ok; } catch { ok = false; }
      await ctx.runMutation(internal.alerts.settle, { id, delivered: ok });
      if (ok) delivered++;
    }
    return { delivered, undelivered: pending.length - delivered, channel: "configured" };
  },
});

export const status = internalQuery({
  args: {},
  handler: async (ctx) => ({
    open: (await ctx.db.query("opsAlerts").withIndex("by_state", (q) => q.eq("state", "open")).collect()).map((a) => ({ key: a.key, kind: a.kind, count: a.count, openedAt: a.openedAt })),
    undelivered: (await ctx.db.query("opsNotices").withIndex("by_pending", (q) => q.eq("deliveredAt", undefined)).take(101)).length,
    channel: channel() ? "configured" : "unconfigured",
  }),
});
