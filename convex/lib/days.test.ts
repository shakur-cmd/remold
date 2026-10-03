import { describe, expect, it } from "vitest";
import { dayBounds, relativeDays } from "./days";

const at = (iso: string) => Date.parse(iso);
const NY = "America/New_York";

describe("relative ranges name the caller's own calendar days", () => {
  it("today is the local date, which differs from the UTC date just after UTC midnight", () => {
    // 02:00Z on 10 March is still 22:00 on 9 March in New York.
    expect(relativeDays("today", at("2026-03-10T02:00:00Z"), NY)).toEqual({ from: "2026-03-09", to: "2026-03-09" });
    expect(relativeDays("today", at("2026-03-10T02:00:00Z"), "UTC")).toEqual({ from: "2026-03-10", to: "2026-03-10" });
  });

  it("next 7 days runs from today through six days later, across a month end", () => {
    expect(relativeDays("next7", at("2026-01-28T15:00:00Z"), "UTC")).toEqual({ from: "2026-01-28", to: "2026-02-03" });
  });

  it("this month is its first through last day, leap February included", () => {
    expect(relativeDays("thisMonth", at("2028-02-10T12:00:00Z"), "UTC")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(relativeDays("thisMonth", at("2026-12-01T03:00:00Z"), NY)).toEqual({ from: "2026-11-01", to: "2026-11-30" });
  });

  it("overdue is everything before today, with no start", () => {
    expect(relativeDays("overdue", at("2026-03-01T12:00:00Z"), "UTC")).toEqual({ to: "2026-02-28" });
  });

  it("refuses a time zone it does not know", () => {
    expect(() => relativeDays("today", Date.now(), "Mars/Olympus")).toThrow(/time zone/i);
  });
});

describe("day bounds", () => {
  it("a plain date field compares whole dates", () => {
    expect(dayBounds({}, "2026-03-08", "2026-03-09", NY)).toEqual({ from: at("2026-03-08T00:00:00Z"), to: at("2026-03-09T00:00:00Z") });
  });

  it("a with-time field gets a 23-hour day when clocks spring forward", () => {
    const b = dayBounds({ withTime: true }, "2026-03-08", "2026-03-08", NY);
    expect(b).toEqual({ from: at("2026-03-08T05:00:00Z"), to: at("2026-03-09T04:00:00Z") - 1, days: { from: at("2026-03-08T00:00:00Z"), to: at("2026-03-08T00:00:00Z") } });
    expect(b.to! + 1 - b.from!).toBe(23 * 3600_000);
  });

  it("a with-time field gets a 25-hour day when clocks fall back", () => {
    const b = dayBounds({ withTime: true }, "2026-11-01", "2026-11-01", NY);
    expect(b.from).toBe(at("2026-11-01T04:00:00Z"));
    expect(b.to! + 1 - b.from!).toBe(25 * 3600_000);
  });

  it("a day whose midnight is skipped starts when the clocks jump, east or west of UTC", () => {
    // Santiago springs forward at local midnight on 6 September 2026, Beirut on 29 March 2026.
    const santiago = dayBounds({ withTime: true }, "2026-09-06", "2026-09-06", "America/Santiago");
    expect([santiago.from, santiago.to! + 1]).toEqual([at("2026-09-06T04:00:00Z"), at("2026-09-07T03:00:00Z")]);
    const beirut = dayBounds({ withTime: true }, "2026-03-29", "2026-03-29", "Asia/Beirut");
    expect([beirut.from, beirut.to! + 1]).toEqual([at("2026-03-28T22:00:00Z"), at("2026-03-29T21:00:00Z")]);
  });

  it("an open end stays open", () => {
    expect(dayBounds({ withTime: true }, undefined, "2026-02-28", "UTC")).toEqual({ to: at("2026-03-01T00:00:00Z") - 1, days: { to: at("2026-02-28T00:00:00Z") } });
  });
});
