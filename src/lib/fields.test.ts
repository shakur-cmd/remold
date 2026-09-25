import { describe, expect, it } from "vitest";
import { type Field, formatDate, formatNumber, relativeDay, toKey } from "./fields";

const day = 86400000;
const today = Date.UTC(2026, 8, 25); // a Friday

describe("relativeDay", () => {
  it("names today, tomorrow and yesterday", () => {
    expect(relativeDay(today, today)).toBe("Today");
    expect(relativeDay(today + day, today)).toBe("Tomorrow");
    expect(relativeDay(today - day, today)).toBe("Yesterday");
  });
  it("counts days for older overdue dates", () => {
    expect(relativeDay(today - 3 * day, today)).toBe("3 days ago");
  });
  it("uses the weekday within a week and the date beyond it", () => {
    expect(relativeDay(today + 2 * day, today)).toBe(new Date(today + 2 * day).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short" }));
    expect(relativeDay(today + 10 * day, today)).toBe(new Date(today + 10 * day).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric" }));
  });
});

describe("formatDate", () => {
  it("shows the stored UTC day, not the day in the viewer's zone", () => {
    expect(formatDate(today)).toContain("25");
  });
  it("shows nothing for a missing date", () => {
    expect(formatDate(undefined)).toBe("");
  });
});

describe("toKey", () => {
  it("camel-cases a label into a key", () => {
    expect(toKey("Close date")).toBe("closeDate");
    expect(toKey("Postal-Code 2")).toBe("postalCode2");
  });
});

describe("formatNumber", () => {
  const field = (key: string) => ({ key, type: "number" }) as Field;
  it("shows the standard amount field as money", () => {
    expect(formatNumber(field("amount"), 4500)).toBe((4500).toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }));
  });
  it("shows any other number as a plain number, so hours never read as dollars", () => {
    expect(formatNumber(field("hours"), 8)).toBe("8");
  });
});
