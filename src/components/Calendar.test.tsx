/// <reference types="node" />
process.env.TZ = "America/New_York";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { CalendarGrid } from "./Calendar";
import { monthDays, weekDays } from "@/lib/calendar";

const planned = { _id: "planned", key: "planned", type: "date", withTime: true } as any;
const status = { _id: "status", key: "status", type: "select", options: [{ id: "idea", label: "Idea" }, { id: "drafted", label: "Drafted" }] } as any;
// 11:30 PM in New York on Oct 5 is already Oct 6 in UTC.
const post = { _id: "r1", title: "Late night reel", values: { planned: new Date(2026, 9, 5, 23, 30).getTime(), status: "drafted" } } as any;

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
    expect(week["2026-10-05"]).toContain("11:30");
    expect(week["2026-10-06"]).not.toContain("Late night reel");
  });
  it("links each record to its page and labels its color", () => {
    const week = render("week", weekDays(Date.UTC(2026, 9, 5)));
    expect(week["2026-10-05"]).toContain('href="/o/org/post/r1"');
    expect(week["2026-10-05"]).toContain("Drafted");
  });
});
