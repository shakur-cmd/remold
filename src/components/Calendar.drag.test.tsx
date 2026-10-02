// @vitest-environment jsdom
/// <reference types="node" />
process.env.TZ = "America/New_York";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { api, objectFields, userAndOrg } from "../../convex/test.helpers";
import { inputToDate } from "@/lib/fields";

// The real Calendar and dnd-kit, with convex/react served by a convex-test
// backend: query results are read from the backend before rendering (keyed by
// function and cursor), mutations run through applyChange.
const backend = vi.hoisted(() => ({ client: null as any, results: new Map<string, unknown>(), pending: [] as Promise<unknown>[], last: null as null | { queries: unknown; shape: string }, resubscribed: 0 }));
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (ref: any, args: any) => (args === "skip" ? undefined : backend.results.get(`${getFunctionName(ref)}|${args?.cursor ?? ""}`)),
    // Like Convex, a new queries object means a new subscription; count needless ones.
    useQueries: (queries: Record<string, { query: any; args: any }>) => {
      const shape = JSON.stringify(Object.entries(queries).map(([k, { query, args }]) => [k, getFunctionName(query), args]));
      if (backend.last && backend.last.queries !== queries && backend.last.shape === shape) backend.resubscribed++;
      backend.last = { queries, shape };
      return Object.fromEntries(Object.entries(queries).map(([k, { query, args }]) => [k, backend.results.get(`${getFunctionName(query)}|${args?.cursor ?? ""}`)]));
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
beforeEach(() => { host = document.body.appendChild(document.createElement("div")); layout(); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("dragging a post to another day saves that day and keeps its local time, even when the new time is midnight UTC", async () => {
  const { t, client, orgId } = await userAndOrg();
  backend.client = client;
  const post = await objectFields(client, orgId, "post");
  const planned = post.fields.planned;
  const { recordId } = await client.mutation(api.records.create, { orgId, objectId: post.object._id, values: { [post.fields.title._id]: "Evening reel", [planned._id]: inputToDate("2026-10-05T20:00", planned) } });
  const detail = await client.query(api.objects.get, { orgId, objectId: post.object._id });
  backend.results.set(`${getFunctionName(api.records.inRange)}|`, await client.query(api.records.inRange, { orgId, objectId: post.object._id, fieldId: planned._id, firstDay: Date.UTC(2026, 9, 4), lastDay: Date.UTC(2026, 9, 10), start: Date.UTC(2026, 9, 4, 4), end: Date.UTC(2026, 9, 11, 4) - 1 }));
  await act(async () => {
    root = createRoot(host);
    root.render(<MemoryRouter initialEntries={["/?view=calendar&cal=week&at=2026-10-05"]}><Calendar orgId={orgId} object={detail.object} fields={detail.fields} /></MemoryRouter>);
  });
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

it("follows a page that is not done and shows the records of the next one", async () => {
  const record = (id: string, title: string, day: number) => ({ _id: id, title, values: { p: Date.UTC(2026, 9, day, 16) } });
  const name = getFunctionName(api.records.inRange);
  backend.results.set(`${name}|`, { records: [record("a", "First page post", 5)], done: false, cursor: "c1" });
  backend.results.set(`${name}|c1`, { records: [record("b", "Second page post", 7)], done: true, cursor: null });
  const object = { _id: "o", key: "post", labelPlural: "Posts" } as any;
  const fields = [{ _id: "p", key: "planned", label: "Planned", type: "date", withTime: true, slot: { kind: "d", index: 0 } }] as any;
  await act(async () => { root = createRoot(host); root.render(<MemoryRouter initialEntries={["/?view=calendar&cal=week&at=2026-10-05"]}><Calendar orgId={"org" as any} object={object} fields={fields} /></MemoryRouter>); });
  expect(host.querySelector('[data-day="2026-10-05"]')!.textContent).toContain("First page post");
  expect(host.querySelector('[data-day="2026-10-07"]')!.textContent).toContain("Second page post");
  // Re-rendering with the same pages must not hand useQueries a new object (the real one would resubscribe forever).
  backend.resubscribed = 0;
  await act(async () => { root.render(<MemoryRouter initialEntries={["/?view=calendar&cal=week&at=2026-10-05"]}><Calendar orgId={"org" as any} object={object} fields={fields} /></MemoryRouter>); });
  expect(backend.resubscribed).toBe(0);
});

