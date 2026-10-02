import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// Loads logic.js and Code.gs into one shared global scope, the way Apps Script
// loads a project's files, with stubbed Google services.
const source = ["logic.js", "Code.gs"].map((file) => readFileSync(join(__dirname, file), "utf8")).join("\n");
const OWNER = "shakur@codemyvibe.com", ALIAS = "hello@remoldcrm.com", BASE = "https://remold.example";
type Msg = { id: string; date: string; from: string; to?: string; cc?: string; bcc?: string; draft?: boolean };
const forbidden = ["getSubject", "getBody", "getPlainBody", "getRawContent", "getAttachments", "getHeader"];

function world(options: { messages: Msg[]; people: { id: string; email?: string }[]; logged?: { source: string; about: string }[]; onSleep?: (ms: number) => void; props?: Record<string, string>; onSearch?: (start: number, threads: { m: Msg; messages: any[] }[], message: (m: Msg) => any) => void; respond?: (call: { url: string; body: any; headers: Record<string, string> }, n: number) => { status: number; body?: unknown; headers?: Record<string, string> } }) {
  const props: Record<string, string> = { REMOLD_BASE_URL: BASE, REMOLD_KEY: "rm_" + "a".repeat(40), ...options.props };
  const calls: { method: string; url: string; body: any; headers: Record<string, string> }[] = [], searches: string[] = [];
  const message = (m: Msg) => {
    const stub: Record<string, () => unknown> = { getId: () => m.id, getDate: () => new Date(m.date), getFrom: () => m.from, getTo: () => m.to ?? "", getCc: () => m.cc ?? "", getBcc: () => m.bcc ?? "", isDraft: () => !!m.draft };
    for (const name of forbidden) stub[name] = () => { throw new Error(`${name} must never be called`); };
    return stub;
  };
  // One thread per message, newest first like Gmail; search honours the addresses and the after:/before: bounds.
  const threads = options.messages.map((m) => ({ m, messages: [message(m)] }));
  const GmailApp = {
    search: (query: string, start: number, max: number) => {
      searches.push(query);
      options.onSearch?.(start, threads, message);
      const after = Number(/after:(\d+)/.exec(query)?.[1] ?? 0) * 1000, before = Number(/before:(\d+)/.exec(query)?.[1] ?? Infinity) * 1000, emails = [...query.matchAll(/(?:from|to|cc|bcc):(\S+?)(?=\s|\)|$)/g)].map((x) => x[1]!.toLowerCase());
      const hit = threads.filter(({ m }) => Date.parse(m.date) > after && Date.parse(m.date) < before && emails.some((e) => [m.from, m.to, m.cc, m.bcc].join(",").toLowerCase().includes(e)));
      return hit.slice(start, start + max).map((thread) => ({ getMessages: () => thread.messages }));
    },
    getMessagesForThreads: (list: any[]) => list.map((thread) => thread.getMessages()),
    getAliases: () => [ALIAS],
  };
  const response = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => ({ getResponseCode: () => status, getContentText: () => JSON.stringify(body), getHeaders: () => headers });
  const UrlFetchApp = {
    fetch: (url: string, params: any) => {
      const call = { method: params.method, url, body: params.payload ? JSON.parse(params.payload) : undefined, headers: params.headers };
      calls.push(call);
      if (params.method === "get" && new URL(url).searchParams.get("object") === "activity") return response(200, { records: (options.logged ?? []).map((a, i) => ({ id: `a${i}`, values: { title: "Email", type: "email", source: a.source, about: { id: a.about } } })), cursor: null });
      if (params.method === "get") {
        const page = Number(new URL(url).searchParams.get("cursor") ?? 0), size = 2;
        return response(200, { records: options.people.slice(page, page + size).map((p) => ({ id: p.id, values: p.email ? { name: p.id, email: p.email } : { name: p.id } })), cursor: page + size < options.people.length ? String(page + size) : null });
      }
      const custom = options.respond?.(call, calls.filter((c) => c.method === "post").length);
      return custom ? response(custom.status, custom.body, custom.headers) : response(200, { record: { id: "r" }, eventId: "e" });
    },
  };
  const PropertiesService = { getScriptProperties: () => ({ getProperty: (k: string) => props[k] ?? null, setProperty: (k: string, v: string) => { props[k] = v; } }) };
  const sleeps: number[] = [];
  const context = vm.createContext({ GmailApp, UrlFetchApp, PropertiesService, Session: { getEffectiveUser: () => ({ getEmail: () => OWNER }) }, Utilities: { sleep: (ms: number) => { sleeps.push(ms); options.onSleep?.(ms); } }, console: { log: () => {} }, Date, JSON, Math, Object, Array, String, Number, Error, encodeURIComponent, URL });
  vm.runInContext(source, context);
  const posts = () => calls.filter((c) => c.method === "post");
  // A fixed clock unless a test brings its own: the run must not depend on the wall clock.
  const sync = (start: number, opts: Record<string, unknown> = {}) => (context as any).syncGmail(start, { now: () => start, ...opts });
  return { context: context as any, sync, props, calls, posts, searches, sleeps };
}

const NOW = Date.UTC(2026, 9, 2, 6, 0);
const people = [{ id: "p_ada", email: "Ada@Example.com" }, { id: "p_bob", email: "bob@example.com" }, { id: "p_none" }, { id: "p_cat", email: "cat@example.org" }];
const messages: Msg[] = [
  { id: "m1", date: "2026-09-30T13:05:00Z", from: "Ada Lovelace <ada@example.com>", to: `Shakur <${OWNER}>` },
  { id: "m2", date: "2026-09-30T15:00:00Z", from: `"Shakur A" <${OWNER}>`, to: "ada@example.com, Bob <BOB@example.com>" },
  { id: "m3", date: "2026-10-01T09:30:00Z", from: ALIAS, to: "someone@else.com", cc: "cat@example.org" },
  { id: "m4", date: "2026-10-01T10:00:00Z", from: "noise@else.com", to: OWNER, cc: "bob@example.com" },
  { id: "m5", date: "2026-10-01T11:00:00Z", from: OWNER, to: "ada@example.com", draft: true },
];

describe("gmail-sync logic", () => {
  it("builds a from/to/cc query with an after: bound, and leaves out addresses that could change the query", () => {
    const { context } = world({ messages: [], people: [] });
    const query = context.buildQuery(["ada@example.com", "bob@example.com"], Date.UTC(2026, 8, 1));
    for (const e of ["ada@example.com", "bob@example.com"]) for (const op of ["from", "to", "cc"]) expect(query).toContain(`${op}:${e}`);
    expect(query).toContain(`after:${Date.UTC(2026, 8, 1) / 1000}`);
    expect(context.cleanEmail(" Ada@Example.COM ")).toBe("ada@example.com");
    for (const bad of ["ada@example.com OR in:anywhere", "a b@c.com", "(x)@y.com", "no-at-sign", "x@y.com}", ""]) expect(context.cleanEmail(bad)).toBeNull();
  });

  it("tells sent from received by the From address against the owner's own addresses", () => {
    const { context } = world({ messages: [], people: [] });
    const owners = context.ownerAddresses(OWNER, [ALIAS], "other@codemyvibe.com, ");
    expect(context.direction(`"Shakur A" <${OWNER.toUpperCase()}>`, owners)).toBe("sent");
    expect(context.direction(ALIAS, owners)).toBe("sent");
    expect(context.direction("Other <other@codemyvibe.com>", owners)).toBe("sent");
    expect(context.direction("Ada <ada@example.com>", owners)).toBe("received");
    expect(context.direction(`Ada <ada@example.com> (via ${OWNER})`, owners)).toBe("received");
  });
});

describe("gmail-sync run", () => {
  it("posts one email Activity per message and person, both directions, reading only ids, dates and addresses", () => {
    const w = world({ messages, people });
    const summary = w.sync(NOW);
    const sent = w.posts().map((c) => ({ url: c.url, key: c.headers["Idempotency-Key"], auth: c.headers.Authorization, body: c.body }));
    expect(sent.map((s) => s.key)).toEqual(["gmail:m1:p_ada", "gmail:m2:p_ada", "gmail:m2:p_bob", "gmail:m3:p_cat"]);
    expect(sent[0]).toEqual({ url: `${BASE}/api/v1/changes`, key: "gmail:m1:p_ada", auth: "Bearer rm_" + "a".repeat(40), body: { action: "create", object: "activity", values: { title: "Email received", type: "email", when: "2026-09-30T13:05:00.000Z", about: "p_ada", source: "gmail:m1" }, reason: "Gmail sync" } });
    expect(sent[1]!.body.values).toEqual({ title: "Email sent", type: "email", when: "2026-09-30T15:00:00.000Z", about: "p_ada", source: "gmail:m2" });
    expect(sent[3]!.body.values.title).toBe("Email sent");
    // m4 only copied Bob on someone else's mail to the owner, and m5 is a draft: neither is contact.
    expect(summary).toMatchObject({ posted: 4, people: 3, complete: true });
    expect(w.calls.filter((c) => c.method === "get" && c.url.includes("object=person")).map((c) => c.url)).toEqual([`${BASE}/api/v1/records?object=person&limit=100`, `${BASE}/api/v1/records?object=person&limit=100&cursor=2`]);
  });

  it("a rerun over the same messages posts the same idempotency keys", () => {
    const first = world({ messages, people });
    first.sync(NOW);
    const again = world({ messages, people, props: { WATERMARK: String(Date.UTC(2026, 8, 30, 13, 30)) } });
    again.sync(NOW + 86400000);
    // The overlap re-reads m1 (13:05, within an hour of the watermark) with the same key as before.
    expect(again.posts().map((c) => c.headers["Idempotency-Key"])).toEqual(first.posts().map((c) => c.headers["Idempotency-Key"]));
    expect(again.searches.every((q) => q.includes(`after:${(Date.UTC(2026, 8, 30, 13, 30) - 3600000) / 1000}`))).toBe(true);
  });

  it("starts from the lookback on a first run and stores the run's start as the watermark only after every post succeeded", () => {
    const w = world({ messages, people, props: { LOOKBACK_DAYS: "10" } });
    expect(w.props.WATERMARK).toBeUndefined();
    w.sync(NOW);
    expect(w.searches[0]).toContain(`after:${(NOW - 10 * 86400000) / 1000}`);
    expect(w.props.WATERMARK).toBe(String(NOW));
  });

  it("stops at the first 4xx, reports it, and keeps the watermark at the last finished window", () => {
    const w = world({ messages, people, props: { WATERMARK: "1" }, respond: (_call, n) => (n === 2 ? { status: 403, body: { error: { code: "FORBIDDEN", message: "No grant" } } } : undefined) });
    expect(() => w.sync(NOW)).toThrow(/403 FORBIDDEN: No grant/);
    expect(w.posts()).toHaveLength(2);
    // The empty 14-day windows before the failing one finished; the failing one (the last 6 days) did not.
    expect(w.props.WATERMARK).toBe(String(NOW - 6 * 86400000));
    expect(w.props.LAST_ERROR).toMatch(/403 FORBIDDEN: No grant/);
    expect(w.props.LAST_ERROR).not.toContain("rm_");
  });

  it("waits out a rate limit and retries the same post", () => {
    const w = world({ messages, people, respond: (_call, n) => (n === 1 ? { status: 429, body: { error: { code: "RATE_LIMITED" } }, headers: { "Retry-After": "7" } } : undefined) });
    expect(w.sync(NOW)).toMatchObject({ posted: 4, complete: true });
    expect(w.sleeps).toEqual([7000]);
    expect(w.posts().map((c) => c.headers["Idempotency-Key"]).slice(0, 2)).toEqual(["gmail:m1:p_ada", "gmail:m1:p_ada"]);
  });

  it("out of time, it advances the watermark only to the last message whose posts all went through", () => {
    let clock = NOW;
    const w = world({ messages, people, respond: () => { clock += 60000; return undefined; } });
    const summary = w.sync(NOW, { now: () => clock, budgetMs: 150000 });
    expect(summary).toMatchObject({ posted: 3, complete: false });
    // m2 had two posts and both landed before time ran out; m3 was never posted.
    expect(w.props.WATERMARK).toBe(String(Date.parse("2026-09-30T15:00:00Z")));
  });

  it("re-reads the first page after paging, so a thread that moved to the front mid-run is not skipped", () => {
    const older: Msg = { id: "m0", date: "2026-09-29T08:00:00Z", from: "Ada <ada@example.com>", to: OWNER };
    // Gmail lists threads by their newest message. While page two is fetched, the oldest thread gets a reply and jumps to the front.
    const w = world({ messages: [messages[3]!, messages[1]!, older], people, onSearch: (start, threads, message) => {
      if (start !== 2 || threads[0]!.m === older) return;
      const moved = threads.splice(threads.findIndex((t) => t.m === older), 1)[0]!;
      moved.messages.push(message({ id: "m9", date: "2026-10-02T05:59:00Z", from: "noise@else.com", to: OWNER }));
      threads.unshift(moved);
    } });
    w.sync(NOW, { pageSize: 2 });
    expect(w.posts().map((c) => c.headers["Idempotency-Key"])).toEqual(["gmail:m0:p_ada", "gmail:m2:p_ada", "gmail:m2:p_bob"]);
  });

  it("reads a long lookback in windows, oldest first, and moves the watermark only over windows whose posts all went through", () => {
    const all = world({ messages, people, props: { LOOKBACK_DAYS: "30", WINDOW_DAYS: "29" } });
    expect(all.sync(NOW)).toMatchObject({ posted: 4, complete: true });
    const until = NOW - 86400000;
    expect(all.searches[0]).toContain(`after:${(NOW - 30 * 86400000) / 1000} before:${until / 1000}`);
    expect(all.searches[1]).toContain(`after:${until / 1000} -in:chats`);
    expect(all.props.WATERMARK).toBe(String(NOW));
    // Out of time after the first window: m3 waits for the next run, which starts from the end of that window.
    let clock = NOW;
    const cut = world({ messages, people, props: { LOOKBACK_DAYS: "30", WINDOW_DAYS: "29" }, onSearch: () => { clock += 100000; } });
    expect(cut.sync(NOW, { now: () => clock, budgetMs: 150000 })).toMatchObject({ posted: 3, complete: false });
    expect(cut.posts().map((c) => c.headers["Idempotency-Key"])).toEqual(["gmail:m1:p_ada", "gmail:m2:p_ada", "gmail:m2:p_bob"]);
    expect(cut.props.WATERMARK).toBe(String(until));
    const next = world({ messages, people, props: { WATERMARK: cut.props.WATERMARK!, WINDOW_DAYS: "29" } });
    next.sync(NOW);
    expect(next.posts().map((c) => c.headers["Idempotency-Key"])).toEqual(["gmail:m3:p_cat"]);
    expect(next.props.WATERMARK).toBe(String(NOW));
  });

  it("when reading Gmail alone runs out of time, it halves the window for the next run and posts nothing", () => {
    let clock = NOW;
    const w = world({ messages, people, props: { WATERMARK: String(Date.UTC(2026, 8, 29)) }, onSearch: () => { clock += 200000; } });
    const summary = w.sync(NOW, { now: () => clock, budgetMs: 150000, pageSize: 1 });
    expect(summary).toMatchObject({ posted: 0, complete: false });
    expect(w.posts()).toHaveLength(0);
    expect(w.props.WATERMARK).toBe(String(Date.UTC(2026, 8, 29)));
    expect(w.props.WINDOW_DAYS).toBe("7");
  });

  it("counts a read that ends past the time limit as out of time, so the next run halves the window instead of stalling", () => {
    let clock = NOW;
    const w = world({ messages, people, props: { WATERMARK: String(Date.UTC(2026, 8, 29)) }, onSearch: () => { clock += 200000; } });
    expect(w.sync(NOW, { now: () => clock, budgetMs: 150000 })).toMatchObject({ posted: 0, complete: false });
    expect(w.props.WINDOW_DAYS).toBe("7");
  });

  it("logs nothing when the owner is a Person: sent-to-self is not contact, and the Gmail query never names the owner", () => {
    const self: Msg[] = [{ id: "s1", date: "2026-09-30T13:05:00Z", from: OWNER, to: OWNER }, { id: "s2", date: "2026-09-30T14:00:00Z", from: ALIAS, to: `Me <${OWNER}>` }, { id: "s3", date: "2026-09-30T15:00:00Z", from: `Me <${OWNER}>`, to: "ada@example.com" }];
    const w = world({ messages: self, people: [...people, { id: "p_me", email: OWNER.toUpperCase() }, { id: "p_alias", email: ALIAS }] });
    expect(w.sync(NOW)).toMatchObject({ complete: true });
    expect(w.posts().map((c) => c.headers["Idempotency-Key"])).toEqual(["gmail:s3:p_ada"]);
    expect(w.searches.length).toBeGreaterThan(0);
    for (const query of w.searches) for (const own of [OWNER, ALIAS]) expect(query).not.toContain(own);
  });

  it("posts only Ada's activity for mail from the owner to Ada with the owner cc'd, when the owner is also a Person", () => {
    const w = world({ messages: [{ id: "c1", date: "2026-09-30T13:05:00Z", from: `Me <${OWNER}>`, to: "Ada <ada@example.com>", cc: `${OWNER}, ${ALIAS}` }], people: [...people, { id: "p_me", email: OWNER }, { id: "p_alias", email: ALIAS }] });
    expect(w.sync(NOW)).toMatchObject({ posted: 1, complete: true });
    expect(w.posts().map((c) => c.body.values.about)).toEqual(["p_ada"]);
  });

  for (const raw of ["0", "-3", "1.5", "1e1", "0x10", "+5", "abc", " "]) {
    it(`reads in default 14-day windows when WINDOW_DAYS is ${JSON.stringify(raw)}: only a positive whole number counts`, () => {
      // A clock that moves with each search, so a window that never advances runs out of time instead of looping.
      let clock = NOW;
      const w = world({ messages, people, props: { LOOKBACK_DAYS: "30", WINDOW_DAYS: raw }, onSearch: () => { clock += 1000; } });
      expect(w.sync(NOW, { now: () => clock })).toMatchObject({ posted: 4, complete: true });
      expect(w.searches[0]).toContain(`after:${(NOW - 30 * 86400000) / 1000} before:${(NOW - 16 * 86400000) / 1000}`);
    });
  }

  it("reads the default 90-day lookback when LOOKBACK_DAYS is not a positive whole number", () => {
    for (const raw of ["-5", "2.5", "1e1"]) expect(world({ messages, people, props: { LOOKBACK_DAYS: raw } }).sync(NOW).from).toBe(new Date(NOW - 90 * 86400000).toISOString());
  });

  it("records LAST_ERROR when a run makes no progress, and clears it once a run moves the watermark", () => {
    let clock = NOW;
    const mark = String(Date.UTC(2026, 8, 29));
    const w = world({ messages, people, props: { WATERMARK: mark, LAST_ERROR: "" }, onSearch: () => { clock += 200000; } });
    expect(w.sync(NOW, { now: () => clock, budgetMs: 150000 })).toMatchObject({ posted: 0, complete: false });
    expect(w.props.WATERMARK).toBe(mark);
    expect(w.props.LAST_ERROR).toMatch(/^2026-10-02T06:00:00.000Z No progress/);
    const stuck = world({ messages, people, onSleep: () => {}, props: { WATERMARK: mark }, respond: () => ({ status: 429, body: { error: { code: "RATE_LIMITED" } }, headers: { "Retry-After": "1000" } }) });
    expect(stuck.sync(NOW)).toMatchObject({ posted: 0, complete: false });
    expect(stuck.props.LAST_ERROR).toMatch(/No progress/);
    const next = world({ messages, people, props: { WATERMARK: mark, LAST_ERROR: w.props.LAST_ERROR! } });
    next.sync(NOW);
    expect(next.props.LAST_ERROR).toBe("");
  });

  it("never sleeps a Retry-After past the run's remaining time: it stops early and keeps what went through", () => {
    let clock = NOW;
    const w = world({ messages, people, onSleep: (ms) => { clock += ms; }, respond: (_call, n) => (n >= 2 ? { status: 429, body: { error: { code: "RATE_LIMITED" } }, headers: { "Retry-After": "100" } } : undefined) });
    const summary = w.sync(NOW, { now: () => clock });
    expect(summary).toMatchObject({ posted: 1, complete: false });
    expect(w.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(270000);
    expect(clock - NOW).toBeLessThanOrEqual(270000);
    expect(w.props.WATERMARK).toBe(String(Date.parse("2026-09-30T13:05:00Z")));
    expect(w.props.LAST_ERROR).toBe("");
  });

  it("saves the watermark after each finished window, so a failure in a later window keeps the earlier ones", () => {
    const w = world({ messages, people, props: { LOOKBACK_DAYS: "30", WINDOW_DAYS: "29" }, respond: (_call, n) => (n === 4 ? { status: 500, body: { error: { code: "INTERNAL" } } } : undefined) });
    expect(() => w.sync(NOW)).toThrow(/500/);
    expect(w.posts()).toHaveLength(4);
    expect(w.props.WATERMARK).toBe(String(NOW - 86400000));
  });

  it("skips emails Remold already has as activities, so reruns past the 24-hour Idempotency-Key window log nothing twice", () => {
    const w = world({ messages, people, logged: [{ source: "gmail:m1", about: "p_ada" }, { source: "gmail:m2", about: "p_bob" }, { source: "manual", about: "p_cat" }] });
    expect(w.sync(NOW)).toMatchObject({ posted: 2, complete: true });
    expect(w.posts().map((c) => c.headers["Idempotency-Key"])).toEqual(["gmail:m2:p_ada", "gmail:m3:p_cat"]);
    const read = w.calls.filter((c) => c.method === "get" && c.url.includes("object=activity")).map((c) => new URL(c.url).searchParams.get("range[when]"));
    // Only the window with mail to post is checked: the last 6 of the 90 days, in 14-day windows.
    expect(read).toEqual([`${new Date(NOW - 6 * 86400000).toISOString()}..${new Date(NOW).toISOString()}`]);
  });
});
