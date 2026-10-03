// @vitest-environment jsdom
/// <reference types="node" />
process.env.TZ = "America/New_York";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { api, objectFields, userAndOrg } from "../../convex/test.helpers";
import { inputToDate } from "@/lib/fields";

// The real Calendar and dnd-kit, with convex/react served live by a convex-test
// backend: every query a render subscribes to is remembered, and sync() re-runs
// them all against the backend and re-renders until nothing changes, as live
// subscriptions would. Mutations run through applyChange.
const backend = vi.hoisted(() => ({ client: null as any, subscribed: new Map<string, { query: any; args: any }>(), results: new Map<string, unknown>(), pending: [] as Promise<unknown>[], last: null as null | { queries: unknown; shape: string }, resubscribed: 0 }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  const read = (query: any, args: any) => { const key = JSON.stringify([getFunctionName(query), args]); backend.subscribed.set(key, { query, args }); return backend.results.get(key); };
  return {
    useQuery: (query: any, args: any) => (args === "skip" ? undefined : read(query, args)),
    // Like Convex, a new queries object means a new subscription; count needless ones.
    useQueries: (queries: Record<string, { query: any; args: any }>) => {
      const shape = JSON.stringify(Object.entries(queries).map(([k, { query, args }]) => [k, getFunctionName(query), args]));
      if (backend.last && backend.last.queries !== queries && backend.last.shape === shape) backend.resubscribed++;
      backend.last = { queries, shape };
      return Object.fromEntries(Object.entries(queries).map(([k, { query, args }]) => [k, read(query, args)]));
    },
    useMutation: (ref: unknown) => (args: unknown) => { const p = backend.client.mutation(ref, args); backend.pending.push(p); return p; },
  };
});
const { Calendar } = await import("./Calendar");

// jsdom has no layout: give each week day column a 100 px wide box and each chip a box inside its day.
const DAYS = ["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"];
function layout() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const cell = this.closest("[data-day]"), x = cell ? DAYS.indexOf(cell.getAttribute("data-day")!) * 100 : 0;
    const box = (left: number, top: number, width: number, height: number) => ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON() {} }) as DOMRect;
    if (this.hasAttribute("data-day")) return box(x, 0, 100, 400);
    if (cell && this.tagName === "A") return box(x + 10, 50, 80, 30);
    return box(0, 0, 0, 0);
  });
}
const pointer = (target: EventTarget, type: string, clientX: number, clientY: number) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 });
  Object.defineProperty(event, "isPrimary", { value: true });
  target.dispatchEvent(event);
};

let root: Root, host: HTMLDivElement;
beforeEach(() => { host = document.body.appendChild(document.createElement("div")); layout(); backend.subscribed.clear(); backend.results.clear(); });
const week = (orgId: any, detail: any) => <MemoryRouter initialEntries={["/?view=calendar&cal=week&at=2026-10-05"]}><Calendar orgId={orgId} object={detail.object} fields={detail.fields} /></MemoryRouter>;
// Re-runs every subscribed query and re-renders, until the results stop changing.
async function sync(view: () => ReactElement) {
  for (let round = 0; round < 20; round++) {
    let changed = false;
    for (const [key, { query, args }] of [...backend.subscribed]) {
      const result = await backend.client.query(query, args);
      if (JSON.stringify(backend.results.get(key)) !== JSON.stringify(result)) { backend.results.set(key, result); changed = true; }
    }
    const before = backend.subscribed.size;
    await act(async () => { root.render(view()); });
    if (!changed && backend.subscribed.size === before && round > 0) return;
  }
  throw new Error("queries never settled");
}
// Titles of the chips on the week view (each chip's first line is its title).
const shown = () => [...host.querySelectorAll("[data-day] a span.font-medium")].map((span) => span.textContent!);
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("dragging a post to another day saves that day and keeps its local time, even when the new time is midnight UTC", async () => {
  const { t, client, orgId } = await userAndOrg();
  backend.client = client;
  const post = await objectFields(client, orgId, "post");
  const planned = post.fields.planned;
  const { recordId } = await client.mutation(api.records.create, { orgId, objectId: post.object._id, values: { [post.fields.title._id]: "Evening reel", [planned._id]: inputToDate("2026-10-05T20:00", planned) } });
  const detail = await client.query(api.objects.get, { orgId, objectId: post.object._id });
  await act(async () => { root = createRoot(host); });
  await sync(() => week(orgId, detail));
  const chip = host.querySelector('[data-day="2026-10-05"] a')!;
  expect(chip.textContent).toContain("Evening reel");
  await act(async () => { pointer(chip, "pointerdown", 150, 65); });
  for (const x of [160, 250, 350, 450]) await act(async () => { pointer(document, "pointermove", x, 65); });
  await act(async () => { pointer(document, "pointerup", 450, 65); });
  await act(async () => { await Promise.all(backend.pending); });
  const stored = (await t.run((ctx: any) => ctx.db.get(recordId)) as any).values[planned._id];
  // Thu Oct 8, 8:00 PM in New York, which is exactly midnight UTC, so stored as an instant (+0.5 ms).
  expect(stored).toBe(Date.UTC(2026, 9, 9) + 0.5);
  expect(new Date(Math.floor(stored)).toString()).toContain("Thu Oct 08 2026 20:00:00");
});

it("says why a date field that is not indexed cannot be used", async () => {
  const object = { _id: "o", key: "event", labelPlural: "Events" } as any;
  const fields = [{ _id: "d", key: "launch", label: "Launch Date", type: "date" }, { _id: "s", key: "status", label: "Status", type: "select", options: [] }] as any;
  await act(async () => { root = createRoot(host); root.render(<MemoryRouter initialEntries={["/?view=calendar&cal=week"]}><Calendar orgId={"org" as any} object={object} fields={fields} /></MemoryRouter>); });
  expect(host.textContent).toMatch(/Launch Date is not indexed, so events can't be placed on a calendar/);
});

// Rendering 501 posts twice in jsdom and re-running every page query takes a few
// seconds, more than vitest's 5 s default on a loaded machine.
const SLOW = 15_000;
// 501 posts at noon on Oct 5, inserted directly so the test stays quick.
async function busyDay() {
  const { t, client, orgId } = await userAndOrg();
  backend.client = client;
  const post = await objectFields(client, orgId, "post"), planned = post.fields.planned;
  const create = (title: string, at: number) => client.mutation(api.records.create, { orgId, objectId: post.object._id, values: { [post.fields.title._id]: title, [planned._id]: at } });
  const { recordId } = await create("Post 0", Date.UTC(2026, 9, 5, 12));
  await t.run(async (ctx: any) => { const { _id, _creationTime, ...doc } = await ctx.db.get(recordId); for (let i = 1; i <= 500; i++) await ctx.db.insert("records", { ...doc, title: `Post ${i}`, values: { ...doc.values, [post.fields.title._id]: `Post ${i}` }, ref: `${doc.ref}-${i}` }); });
  const detail = await client.query(api.objects.get, { orgId, objectId: post.object._id });
  await act(async () => { root = createRoot(host); });
  return { orgId, detail, create };
}

it("follows a page that is not done and shows the records of the next one, without resubscribing", async () => {
  const { orgId, detail } = await busyDay();
  await sync(() => week(orgId, detail));
  expect(shown()).toHaveLength(501);
  // Re-rendering with the same pages must not hand useQueries a new object (the real one would resubscribe forever).
  backend.resubscribed = 0;
  await act(async () => { root.render(week(orgId, detail)); });
  expect(backend.resubscribed).toBe(0);
}, SLOW);

// Astra's r3 live probe: two pages loaded, then a post lands before the first page's end.
it("keeps every post when an insert moves an earlier page boundary while two pages are loaded", async () => {
  const { orgId, detail, create } = await busyDay();
  await sync(() => week(orgId, detail));
  expect(shown()).toHaveLength(501);
  await create("New earlier post", Date.UTC(2026, 9, 5, 11));
  await sync(() => week(orgId, detail));
  const titles = shown();
  expect(titles).toHaveLength(502);
  expect(new Set(titles).size).toBe(502);
  for (const title of ["New earlier post", "Post 499", "Post 500"]) expect(titles).toContain(title);
}, SLOW);
