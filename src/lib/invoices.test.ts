import { describe, expect, it } from "vitest";
import { invoiceStatus } from "./invoices";

const today = Date.UTC(2026, 9, 1), past = Date.UTC(2026, 8, 1), later = Date.UTC(2026, 9, 20);

describe("invoiceStatus", () => {
  it("says overdue only when the caller can see there is no paid date", () => {
    expect(invoiceStatus({ due: past, paidOn: null, today })).toMatchObject({ overdue: true });
    expect(invoiceStatus({ due: past, paidOn: past, today })).toMatchObject({ overdue: false });
    expect(invoiceStatus({ due: later, paidOn: null, today })).toMatchObject({ overdue: false });
  });
  it("a hidden paid date reads as payment status hidden, never overdue or unpaid", () => {
    for (const due of [past, later, null]) expect(invoiceStatus({ due, paidOn: null, paymentHidden: true, today })).toEqual({ label: "Payment status hidden", overdue: false });
  });
});
