/// <reference types="node" />
process.env.TZ = "America/New_York";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { CalendarGrid } from "./Calendar";
import { monthDays, weekDays } from "@/lib/calendar";
import { inputToDate } from "@/lib/fields";

const planned = { _id: "planned", key: "planned", type: "date", withTime: true } as any;
const status = { _id: "status", key: "status", type: "select", options: [{ id: "idea", label: "Idea" }, { id: "drafted", label: "Drafted" }] } as any;
// 8 PM in New York on Oct 5 is exactly midnight Oct 6 in UTC.
const post = { _id: "r1", title: "Late night reel", values: { planned: inputToDate("2026-10-05T20:00", planned), status: "drafted" } } as any;

// The markup of each day cell, keyed by its date.
function cells(html: string) {
  return Object.fromEntries(html.split('data-day="').slice(1).map((part) => [part.slice(0, 10), part.split("data-list")[0]!]));
}
const render = (mode: "month" | "week", days: number[]) =>
  cells(renderToStaticMarkup(<MemoryRouter><CalendarGrid orgId={"org" as any} objectKey="post" mode={mode} days={days} month={9} records={[post]} dateField={planned} colorField={status} today={Date.UTC(2026, 9, 1)} onMove={() => {}} /></MemoryRouter>));

describe("CalendarGrid", () => {
  it("shows a post on its local day in month view", () => {
    const month = render("month", monthDays(Date.UTC(2026, 9, 1)));
    expect(month["2026-10-05"]).toContain("Late night reel");
    expect(month["2026-10-06"]).not.toContain("Late night reel");
    expect(Object.values(month).filter((c) => c.includes("Late night reel"))).toHaveLength(1);
  });
  it("shows a post on its local day with its time in week view", () => {
    const week = render("week", weekDays(Date.UTC(2026, 9, 5)));
    expect(week["2026-10-05"]).toContain("Late night reel");
    expect(week["2026-10-05"]).toContain("8:00");
    expect(week["2026-10-06"]).not.toContain("Late night reel");
  });
  it("links each record to its page and labels its color", () => {
    const week = render("week", weekDays(Date.UTC(2026, 9, 5)));
    expect(week["2026-10-05"]).toContain('href="/o/org/post/r1"');
    expect(week["2026-10-05"]).toContain("Drafted");
  });
  it("shows three posts in a busy month cell and counts the rest", () => {
    const busy = Array.from({ length: 5 }, (_, i) => ({ _id: `b${i}`, title: `Busy ${i}`, values: { planned: new Date(2026, 9, 20, 9 + i).getTime(), status: "idea" } })) as any;
    const html = renderToStaticMarkup(<MemoryRouter><CalendarGrid orgId={"org" as any} objectKey="post" mode="month" days={monthDays(Date.UTC(2026, 9, 1))} month={9} records={busy} dateField={planned} colorField={status} today={Date.UTC(2026, 9, 1)} onMove={() => {}} /></MemoryRouter>);
    const cell = cells(html)["2026-10-20"]!;
    expect(cell).toContain("Busy 2");
    expect(cell).not.toContain("Busy 3");
    expect(cell).toContain("+2 more");
  });
});
