import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Field, dateToInput, formatDate, formatFieldDate, formatNumber, inputToDate, localDay, relativeDay, toKey } from "./fields";

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

describe("date fields with time", () => {
  beforeAll(() => { vi.stubEnv("TZ", "America/New_York"); });
  afterAll(() => { vi.unstubAllEnvs(); });
  const timed = { type: "date", withTime: true } as Field, plain = { type: "date" } as Field;

  it("edits in the browser's local time and stores the instant", () => {
    const at = Date.UTC(2026, 9, 1, 18, 32);
    expect(dateToInput(at, timed)).toBe("2026-10-01T14:32");
    expect(inputToDate("2026-10-01T14:32", timed)).toBe(at);
    expect(inputToDate("", timed)).toBeNull();
  });

  it("treats a stored UTC midnight as that calendar day, not the evening before", () => {
    const midnight = Date.UTC(2026, 9, 3);
    expect(dateToInput(midnight, timed)).toBe("2026-10-03T00:00");
    expect(formatFieldDate(timed, midnight)).toBe(formatDate(midnight));
    expect(localDay(timed, midnight)).toBe(midnight);
  });

  it("shows local time and files late-evening times under the local day", () => {
    const evening = Date.UTC(2026, 9, 2, 1, 30); // 9:30 PM Oct 1 in New York
    expect(formatFieldDate(timed, evening)).toMatch(/Oct 1.*9:30/);
    expect(localDay(timed, evening)).toBe(Date.UTC(2026, 9, 1));
  });

  it("leaves plain date fields as UTC days", () => {
    const day = Date.UTC(2026, 9, 3);
    expect(dateToInput(day, plain)).toBe("2026-10-03");
    expect(inputToDate("2026-10-03", plain)).toBe(day);
    expect(formatFieldDate(plain, day)).toBe(formatDate(day));
    expect(localDay(plain, day)).toBe(day);
  });
});
