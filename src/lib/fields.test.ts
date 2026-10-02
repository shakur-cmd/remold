import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Field, dateToInput, formatDate, formatFieldDate, formatMoney, formatNumber, inputToDate, localDay, relativeDay, timeOfDay, toKey } from "./fields";

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

  it("an instant at exactly 00:00Z edits and shows as that instant, 8 PM the evening before in New York, and round-trips", () => {
    const stored = Date.UTC(2026, 9, 2) + 0.5;
    expect(inputToDate("2026-10-01T20:00", timed)).toBe(stored);
    expect(dateToInput(stored, timed)).toBe("2026-10-01T20:00");
    expect(formatFieldDate(timed, stored)).toMatch(/Oct 1, 2026.*8:00\sPM/);
    expect(timeOfDay(timed, stored)).toMatch(/8:00\sPM/);
    expect(localDay(timed, stored)).toBe(Date.UTC(2026, 9, 1));
  });

  it("files instants either side of local midnight under the right local day", () => {
    expect(localDay(timed, Date.UTC(2026, 9, 2, 3, 59))).toBe(Date.UTC(2026, 9, 1));
    expect(localDay(timed, Date.UTC(2026, 9, 2, 4, 0))).toBe(Date.UTC(2026, 9, 2));
  });
});

describe("plain dates on with-time fields", () => {
  afterAll(() => { vi.unstubAllEnvs(); });
  const timed = { type: "date", withTime: true } as Field, day = Date.UTC(2026, 10, 30);
  for (const zone of ["America/New_York", "Pacific/Pago_Pago", "Asia/Tokyo", "Pacific/Kiritimati"])
    it(`show as that calendar day in ${zone}`, () => {
      vi.stubEnv("TZ", zone);
      expect(formatFieldDate(timed, day)).toBe(formatDate(day));
      expect(formatFieldDate(timed, day)).toMatch(/Nov 30, 2026/);
      expect(timeOfDay(timed, day)).toBeNull();
      expect(localDay(timed, day)).toBe(day);
      // Editing it as a time starts from that day, not from the local reading of UTC midnight.
      expect(dateToInput(day, timed)).toBe("2026-11-30T00:00");
    });
  it("a local time that is not midnight UTC in Tokyo still shows in Tokyo time", () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    expect(formatFieldDate(timed, Date.UTC(2026, 9, 2) + 0.5)).toMatch(/Oct 2, 2026.*9:00\sAM/);
  });
});

describe("formatMoney", () => {
  it("keeps cents when an amount has them and drops them when it does not", () => {
    expect(formatMoney(450.5)).toBe((450.5).toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2 }));
    expect(formatMoney(1200)).toBe((1200).toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }));
  });
});
