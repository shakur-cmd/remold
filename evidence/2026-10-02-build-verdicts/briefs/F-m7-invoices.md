# Job F: M7 money per client (tracking only)
Branch: m7/invoices. Job id: F-m7. Base: integ/m3 (origin), which merges M3 part 1 (date fields with time via the field flag withTime, Activity object, record timeline, history paging) and M3 part 2 (email helper convex/lib/email.ts, daily reminder, agent guards incl. protectedFromAgents and forward-only stage in convex/authority/agentGuards.ts). Reuse them; diff against origin/integ/m3.

Context: read docs/unified-launch/remaining-work-2026-10-01.html section M7. Tracking only: Remold records invoices; it never charges, sends or connects to a payment provider.

Build:
1. Invoice object (standard set + idempotent additive migration): number (title), company (lookup), amount (number), sent (date), due (date), paid on (date), monthly (boolean), document link (text: a file path or URL to the PDF), and the existing timeline.
2. A company page shows its invoices with total billed, total paid and open balance.
3. Today lists unpaid invoices past due; marking one paid (setting "paid on") removes it.
4. Agents may create invoices as proposals only by default (existing grant model); "paid on" is protected from agent writes (reuse the M3 agent field guard if present).

Done when: tests prove open balance per company equals a hand sum over mixed paid/unpaid invoices; a past-due unpaid invoice shows on Today and drops off when paid; an agent cannot set paid on. Full suites pass; pnpm build passes; screenshot of a company page with invoices if a local backend runs (else say so).
