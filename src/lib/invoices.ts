import { formatDate } from "@/lib/fields";

// What a company page says about one invoice's payment.
export function invoiceStatus({ due, paidOn, paymentHidden, today }: { due: number | null; paidOn: number | null; paymentHidden?: boolean; today: number }) {
  // A paid date the caller cannot read looks empty; it must not read as unpaid or overdue.
  if (paymentHidden) return { label: "Payment status hidden", overdue: false };
  if (paidOn !== null) return { label: `Paid ${formatDate(paidOn)}`, overdue: false };
  if (due === null) return { label: "Unpaid", overdue: false };
  return due < today ? { label: `Overdue since ${formatDate(due)}`, overdue: true } : { label: `Due ${formatDate(due)}`, overdue: false };
}
