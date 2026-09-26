declare const process: { env: Record<string, string | undefined> };
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

// Operator alerts. A minute cron reads operational facts in small queries (queries
// never conflict with the writes they read, such as telemetry:record), then applies
// the result in one mutation that touches only alert tables. Scheduled functions are
// scanned incrementally from a saved watermark; work that has not finished when
// scanned is watched by job id until it finishes, however long that takes.
export type Kind = "background-error" | "rest-500" | "stalled" | "coverage";
export type Condition = { key: string; kind: Kind; fn?: string; count: number };
type Outcome = { fn: string; at: number; failed: boolean };
type Summary = { fn: string; lastAt: number; lastFailed: boolean; trailing: number; sawSuccess: boolean };

const LOOKBACK_MS = 60 * 60_000, RETAIN_MS = 7 * 24 * 60 * 60_000;
// Rows created in the last LAG_MS may still be committing, so the scan stops short of now.
const LAG_MS = 10_000, PAGE = 1000, MAX_PAGES = 10, MAX_WATCH_ADD = 2000, WATCH_PAGE = 100, WATCH_PAGES = 10, REST_ROWS = 3000;
// Each claim covers one send; CLAIM_MS is far longer than SEND_TIMEOUT_MS.
const SEND_TIMEOUT_MS = 10_000, CLAIM_MS = 5 * 60_000, MAX_SENDS = 20;
// Reads stop after this long; unread work carries over and the check reports it is behind.
const READ_BUDGET_MS = 30_000;
const setting = (name: string, fallback: number, min: number, max: number) => {
  const n = Number(process.env[name]);
  return process.env[name] && Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};
const fnName = (name: string) => name.replace(/\.js:/, ":");

// Orders outcomes per function: latest result, failures since the last success.
export function summarize(outcomes: Outcome[]): Summary[] {
  const byFn = new Map<string, Summary>();
  for (const o of [...outcomes].sort((a, b) => a.at - b.at)) {
    const s = byFn.get(o.fn) ?? { fn: o.fn, lastAt: 0, lastFailed: false, trailing: 0, sawSuccess: false };
    s.lastAt = o.at; s.lastFailed = o.failed;
    if (o.failed) s.trailing++; else { s.trailing = 0; s.sawSuccess = true; }
    byFn.set(o.fn, s);
  }
  return [...byFn.values()];
}

export function conditions(input: { health: { fn: string; lastAt: number; lastFailed: boolean; failures: number }[]; stalled: { fn: string; count: number }[]; restErrors: number; behind: boolean; now: number }): Condition[] {
  const found: Condition[] = [];
  // A background function is failing while its latest finished run failed (within the lookback).
  for (const h of input.health) if (h.lastFailed && h.lastAt >= input.now - LOOKBACK_MS) found.push({ key: `background-error:${h.fn}`, kind: "background-error", fn: h.fn, count: h.failures });
  for (const s of input.stalled) found.push({ key: `stalled:${s.fn}`, kind: "stalled", fn: s.fn, count: s.count });
  if (input.restErrors) found.push({ key: "rest-500", kind: "rest-500", count: input.restErrors });
  if (input.behind) found.push({ key: "coverage", kind: "coverage", count: 1 });
  return found;
}

// Notifications are built only from the kind, a code-defined function name and
// counts. Error text, arguments, URLs and headers never reach this function.
export function notice(event: "open" | "resolve", c: Condition, at: number) {
  const subject = {
    "background-error": `Background function ${c.fn} is failing`,
    "rest-500": "REST API is returning internal errors (500)",
    stalled: `Scheduled function ${c.fn} is stalled`,
    coverage: "Alert checks are falling behind, so some scheduled work is not checked yet",
  }[c.kind];
  return { source: "remold" as const, event, kind: c.kind, key: c.key, count: c.count, at: new Date(at).toISOString(), summary: event === "open" ? `${subject} (${c.count} seen).` : `Resolved: ${subject.replace(" is ", " was ").replace(" are ", " were ")}.` };
}

const internalHost = (host: string) => {
  if (host === "localhost" || /\.(localhost|local|internal)$/.test(host)) return true;
  if (host.startsWith("[")) { const a = host.slice(1, -1); return a === "::" || a === "::1" || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith("::ffff:"); }
  const ip = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!ip) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
};
// HTTPS to a public host, or plain HTTP to exactly 127.0.0.1 or localhost for local
// rehearsals. The check is on the URL string; a public name resolving to a private
// address is not detected. Redirects are refused at send time.
export function channel(raw = process.env.REMOLD_ALERT_WEBHOOK_URL): string | null {
  let url: URL;
  try { url = new URL(raw ?? ""); } catch { return null; }
  if (url.protocol === "http:") return url.hostname === "127.0.0.1" || url.hostname === "localhost" ? url.href : null;
  return url.protocol === "https:" && !internalHost(url.hostname) ? url.href : null;
}

export const scanState = internalQuery({ args: {}, handler: async (ctx) => (await ctx.db.query("opsAlertScan").first())?.scannedThrough ?? null });

export const scanPage = internalQuery({
  args: { after: v.number(), until: v.number(), limit: v.number() },
  handler: async (ctx, a) => {
    const rows = await ctx.db.system.query("_scheduled_functions").withIndex("by_creation_time", (q) => q.gt("_creationTime", a.after).lte("_creationTime", a.until)).take(a.limit);
    const outcomes: Outcome[] = [], pending: { jobId: Id<"_scheduled_functions">; fn: string; due: number }[] = [];
    for (const r of rows) {
      const kind = r.state.kind, fn = fnName(r.name);
      if (kind === "success" || kind === "failed") outcomes.push({ fn, at: r.scheduledTime, failed: kind === "failed" });
      else if (kind === "pending" || kind === "inProgress") pending.push({ jobId: r._id, fn, due: r.scheduledTime });
    }
    const done = rows.length < a.limit;
    return { outcomes, pending, through: done ? a.until : rows[rows.length - 1]!._creationTime, done };
  },
});

export const watchPage = internalQuery({
  args: { after: v.number(), through: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { after, through, cursor }) => {
    const page = await ctx.db.query("opsAlertWatch").withIndex("by_due", (q) => q.gt("due", after).lte("due", through)).paginate({ cursor, numItems: WATCH_PAGE });
    const rows: { id: Id<"opsAlertWatch">; fn: string; due: number; stalled: boolean; state: string }[] = [];
    for (const w of page.page) rows.push({ id: w._id, fn: w.fn, due: w.due, stalled: w.stalledAt !== undefined, state: (await ctx.db.system.get(w.jobId))?.state.kind ?? "missing" });
    return { rows, cursor: page.continueCursor, done: page.isDone };
  },
});

export const restErrors = internalQuery({
  args: { sinceMinute: v.number() },
  handler: async (ctx, { sinceMinute }) => {
    const rows = await ctx.db.query("opsMetrics").withIndex("by_minute", (q) => q.gte("minute", sinceMinute)).take(REST_ROWS);
    // Only status 500 is a caught internal error; 503 is the deliberate migration pause.
    return rows.length === REST_ROWS ? null : rows.filter((r) => r.route === "rest" && r.status === "500").reduce((n, r) => n + r.serverErrors, 0);
  },
});

const job = v.object({ jobId: v.id("_scheduled_functions"), fn: v.string(), due: v.number(), stalledAt: v.optional(v.number()) });
export const apply = internalMutation({
  args: { from: v.union(v.number(), v.null()), through: v.number(), functions: v.array(v.object({ fn: v.string(), lastAt: v.number(), lastFailed: v.boolean(), trailing: v.number(), sawSuccess: v.boolean() })), watchAdd: v.array(job), watchDone: v.array(v.id("opsAlertWatch")), watchStalled: v.array(v.id("opsAlertWatch")), restErrors: v.union(v.number(), v.null()), behind: v.boolean() },
  handler: async (ctx, args): Promise<boolean> => {
    const now = Date.now();
    // Compare-and-set on the watermark: an overlapping check that scanned the same range loses.
    const cursor = await ctx.db.query("opsAlertScan").first();
    if ((cursor?.scannedThrough ?? null) !== args.from) return false;
    if (cursor) await ctx.db.patch(cursor._id, { scannedThrough: args.through }); else await ctx.db.insert("opsAlertScan", { scannedThrough: args.through });
    for (const w of args.watchAdd) await ctx.db.insert("opsAlertWatch", w);
    for (const id of args.watchDone) if (await ctx.db.get(id)) await ctx.db.delete(id);
    for (const id of args.watchStalled) if (await ctx.db.get(id)) await ctx.db.patch(id, { stalledAt: now });
    for (const s of args.functions) {
      const row = await ctx.db.query("opsAlertFunctions").withIndex("by_fn", (q) => q.eq("fn", s.fn)).unique();
      if (row && s.lastAt < row.lastAt) continue;
      const data = { fn: s.fn, lastAt: s.lastAt, lastFailed: s.lastFailed, failures: s.sawSuccess || !row ? s.trailing : row.failures + s.trailing };
      if (row) await ctx.db.replace(row._id, data); else await ctx.db.insert("opsAlertFunctions", data);
    }
    const health = await ctx.db.query("opsAlertFunctions").take(1000);
    // A stall lives on its watch row, which is removed only once the job finishes.
    const stalled = new Map<string, number>();
    for (const w of await ctx.db.query("opsAlertWatch").withIndex("by_stalled", (q) => q.gt("stalledAt", 0)).take(1000)) stalled.set(w.fn, (stalled.get(w.fn) ?? 0) + 1);
    const open = await ctx.db.query("opsAlerts").withIndex("by_state", (q) => q.eq("state", "open")).collect();
    // An unreadable REST window neither opens nor resolves the REST alert.
    const restErrors = args.restErrors ?? open.find((a) => a.key === "rest-500")?.count ?? 0;
    const found = conditions({ health, stalled: [...stalled].map(([fn, count]) => ({ fn, count })), restErrors, behind: args.behind, now });
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
    return true;
  },
});

export const claim = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const next = (await ctx.db.query("opsNotices").withIndex("by_pending", (q) => q.eq("deliveredAt", undefined)).take(100)).find((n) => (n.claimedUntil ?? 0) <= now);
    if (!next) return null;
    await ctx.db.patch(next._id, { claimedUntil: now + CLAIM_MS });
    return { id: next._id, payload: next.payload };
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

type CheckResult = { applied: boolean; behind: boolean; delivered: number; channel: "configured" | "unconfigured"; scanned?: number; watchAdded?: number; watchChecked?: number; readMs?: number };
export const check = internalAction({
  args: {},
  handler: async (ctx): Promise<CheckResult> => {
    const now = Date.now(), stallMs = setting("REMOLD_ALERT_STALL_MS", 15 * 60_000, 1000, 24 * 60 * 60_000);
    const windowMinutes = setting("REMOLD_ALERT_WINDOW_MINUTES", 5, 1, 60);
    let from: number | null;
    try { from = await ctx.runQuery(internal.alerts.scanState, {}); } catch { return { applied: false, behind: true, delivered: 0, channel: channel() ? "configured" : "unconfigured" }; }
    const outcomes: Outcome[] = [], watchAdd: { jobId: Id<"_scheduled_functions">; fn: string; due: number }[] = [];
    let behind = false, through = from ?? now - LOOKBACK_MS, limit = PAGE, calls = 0, scanned = 0, watchChecked = 0;
    while (true) {
      if (calls++ >= MAX_PAGES || watchAdd.length >= MAX_WATCH_ADD || Date.now() > now + READ_BUDGET_MS) { behind = true; break; }
      try {
        const page = await ctx.runQuery(internal.alerts.scanPage, { after: through, until: now - LAG_MS, limit });
        outcomes.push(...page.outcomes); watchAdd.push(...page.pending); through = page.through; scanned += page.outcomes.length + page.pending.length;
        if (page.done) break;
      } catch {
        // Very large rows can exceed a query's read limit; retry smaller, and report if even one row fails.
        if (limit === 1) { behind = true; break; }
        limit = Math.max(1, Math.floor(limit / 10));
      }
    }
    const watchDone: Id<"opsAlertWatch">[] = [], watchStalled: Id<"opsAlertWatch">[] = [];
    const late = (due: number) => due < now - stallMs;
    const added = watchAdd.map((p) => (late(p.due) ? { ...p, stalledAt: now } : p));
    // Two passes over watched jobs. Jobs already past the stall threshold must all be
    // read, or the check is behind. Recently due jobs are read only to record results;
    // leaving some for the next check is ordinary lag, since none of them can be stalled yet.
    const pass = async (after: number, upTo: number, mustFinish: boolean) => {
      let cursor: string | null = null;
      for (let page = 0; ; page++) {
        if (page === WATCH_PAGES || Date.now() > now + READ_BUDGET_MS) { if (mustFinish) behind = true; return; }
        try {
          const result: { rows: { id: Id<"opsAlertWatch">; fn: string; due: number; stalled: boolean; state: string }[]; cursor: string; done: boolean } = await ctx.runQuery(internal.alerts.watchPage, { after, through: upTo, cursor });
          watchChecked += result.rows.length;
          for (const w of result.rows) {
            if (w.state === "success" || w.state === "failed") { outcomes.push({ fn: w.fn, at: w.due, failed: w.state === "failed" }); watchDone.push(w.id); }
            else if (w.state === "pending" || w.state === "inProgress") { if (late(w.due) && !w.stalled) watchStalled.push(w.id); }
            else watchDone.push(w.id);
          }
          if (result.done) return;
          cursor = result.cursor;
        } catch { if (mustFinish) behind = true; return; }
      }
    };
    await pass(-1, now - stallMs, true);
    await pass(now - stallMs, now, false);
    const readMs = Date.now() - now;
    let restErrors: number | null = null;
    try { restErrors = await ctx.runQuery(internal.alerts.restErrors, { sinceMinute: Math.floor(now / 60_000) - windowMinutes }); } catch { restErrors = null; }
    if (restErrors === null) behind = true;
    let applied = false;
    try { applied = await ctx.runMutation(internal.alerts.apply, { from, through, functions: summarize(outcomes), watchAdd: added, watchDone, watchStalled, restErrors, behind }); }
    catch { behind = true; }
    const url = channel();
    const counts = { scanned, watchAdded: added.length, watchChecked, readMs };
    if (!url) return { applied, behind, delivered: 0, channel: "unconfigured", ...counts };
    let delivered = 0;
    for (let i = 0; i < MAX_SENDS; i++) {
      const next = await ctx.runMutation(internal.alerts.claim, {});
      if (!next) break;
      let ok = false;
      try { ok = (await fetch(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: next.id, ...next.payload }), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) })).ok; } catch { ok = false; }
      await ctx.runMutation(internal.alerts.settle, { id: next.id, delivered: ok });
      // A failed send means the sink is down; the next check retries.
      if (!ok) break;
      delivered++;
    }
    return { applied, behind, delivered, channel: "configured", ...counts };
  },
});

export const status = internalQuery({
  args: {},
  handler: async (ctx) => ({
    open: (await ctx.db.query("opsAlerts").withIndex("by_state", (q) => q.eq("state", "open")).collect()).map((a) => ({ key: a.key, kind: a.kind, count: a.count, openedAt: a.openedAt })),
    undelivered: (await ctx.db.query("opsNotices").withIndex("by_pending", (q) => q.eq("deliveredAt", undefined)).take(101)).length,
    scannedThrough: (await ctx.db.query("opsAlertScan").first())?.scannedThrough ?? null,
    channel: channel() ? "configured" : "unconfigured",
  }),
});
