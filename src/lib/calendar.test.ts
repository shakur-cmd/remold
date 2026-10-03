/// <reference types="node" />
process.env.TZ = "America/New_York";
import { afterEach, describe, expect, it } from "vitest";
import { setWorkspaceZone } from "./zone";
import { type Field, dateToInput, inputToDate } from "./fields";
import { byDay, dayKey, localSpan, monthDays, moveToDay, weekDays } from "./calendar";

const timed = { _id: "f1", type: "date", withTime: true } as unknown as Field;
const plain = { _id: "f2", type: "date" } as unknown as Field;
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();

describe("calendar days", () => {
  it("a month view runs whole weeks from the Sunday before the 1st through the end of the month", () => {
    const days = monthDays(Date.UTC(2026, 9, 15));
    expect(dayKey(days[0]!)).toBe("2026-09-27");
    expect(days.length % 7).toBe(0);
    expect(days.map(dayKey)).toContain("2026-10-31");
    expect(dayKey(days.at(-1)!)).toBe("2026-10-31");
  });
  it("a week view is Sunday to Saturday around the anchor", () => {
    expect(weekDays(Date.UTC(2026, 9, 7)).map(dayKey)).toEqual(["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"]);
  });
  it("places a timed record on its local day, not its UTC day, earliest first", () => {
    const late = { _id: "a", values: { f1: local(2026, 9, 5, 23, 30) } } as any, early = { _id: "b", values: { f1: local(2026, 9, 5, 8) } } as any;
    const days = byDay([late, early], timed);
    expect(days.get(Date.UTC(2026, 9, 5))?.map((r) => r._id)).toEqual(["b", "a"]);
    expect(days.has(Date.UTC(2026, 9, 6))).toBe(false);
  });
});

describe("moveToDay", () => {
  it("keeps the local time of day", () => {
    expect(moveToDay(timed, local(2026, 9, 5, 23, 30), Date.UTC(2026, 9, 9))).toBe(local(2026, 9, 9, 23, 30));
  });
  it("keeps the wall-clock time across a daylight saving change", () => {
    expect(moveToDay(timed, local(2026, 9, 30, 9), Date.UTC(2026, 10, 2))).toBe(local(2026, 10, 2, 9));
  });
  it("moves an all-day or plain date to the target day itself", () => {
    expect(moveToDay(timed, Date.UTC(2026, 9, 5), Date.UTC(2026, 9, 9))).toBe(Date.UTC(2026, 9, 9));
    expect(moveToDay(plain, Date.UTC(2026, 9, 5), Date.UTC(2026, 9, 9))).toBe(Date.UTC(2026, 9, 9));
  });
});

describe("8 PM in New York is midnight UTC", () => {
  const eight = inputToDate("2026-10-05T20:00", timed)!;
  it("stays on its local day", () => {
    expect(byDay([{ _id: "a", values: { f1: eight } } as any], timed).get(Date.UTC(2026, 9, 5))?.map((r) => r._id)).toEqual(["a"]);
  });
  it("keeps 8 PM when moved, stored as an instant rather than an all-day date", () => {
    const moved = moveToDay(timed, eight, Date.UTC(2026, 9, 8));
    expect(moved).toBe(Date.UTC(2026, 9, 9) + 0.5);
    expect(dateToInput(moved, timed)).toBe("2026-10-08T20:00");
    expect(byDay([{ _id: "a", values: { f1: moved } } as any], timed).has(Date.UTC(2026, 9, 8))).toBe(true);
  });
});

describe("localSpan", () => {
  it("runs from local midnight of the first day to the next local midnight after the last, minus 1 ms", () => {
    expect(localSpan(Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 31))).toEqual({ firstDay: Date.UTC(2026, 9, 1), lastDay: Date.UTC(2026, 9, 31), start: local(2026, 9, 1), end: local(2026, 10, 1) - 1 });
  });
  it("is 25 hours long on the day daylight saving ends", () => {
    const span = localSpan(Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 1));
    expect(span.end - span.start).toBe(25 * 3_600_000 - 1);
  });
});


// The browser here is in New York; the workspace is in Auckland, which put its clocks forward on 2026-09-27.
describe("days in the workspace's time zone", () => {
  afterEach(() => setWorkspaceZone(undefined));
  it("places a timed record on the workspace's day, not the browser's", () => {
    setWorkspaceZone("Pacific/Auckland");
    const record = { _id: "a", values: { f1: Date.UTC(2026, 9, 5, 12) } } as any; // 01:00 on the 6th in Auckland, 08:00 on the 5th in New York
    expect([...byDay([record], timed).keys()]).toEqual([Date.UTC(2026, 9, 6)]);
  });
  it("spans a day from the workspace's midnight, 23 hours long on the day its clocks change", () => {
    setWorkspaceZone("Pacific/Auckland");
    const span = localSpan(Date.UTC(2026, 8, 27), Date.UTC(2026, 8, 27));
    expect(span.start).toBe(Date.UTC(2026, 8, 26, 12));
    expect(span.end - span.start + 1).toBe(23 * 3_600_000);
  });
  it("moves a timed record to another day at the same wall clock time in the workspace's zone", () => {
    setWorkspaceZone("Pacific/Auckland");
    const at = Date.UTC(2026, 8, 26, 20, 30); // 09:30 on the 27th in Auckland (after the clock change)
    expect(moveToDay(timed, at, Date.UTC(2026, 8, 29))).toBe(Date.UTC(2026, 8, 28, 20, 30)); // 09:30 NZDT on the 29th
  });
});
