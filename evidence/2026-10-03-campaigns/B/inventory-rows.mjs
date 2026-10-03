// Adds the booking page rows to ops/authority/inventory.json (run once from the repo root).
import { readFileSync, writeFileSync } from "node:fs";
const path = "ops/authority/inventory.json", inventory = JSON.parse(readFileSync(path, "utf8"));
const READONLY = "Readonly workspace refuses every public human write and every agent REST write", MASKS = "Hidden field value never appears in any human query or agent REST read";
const PUBLIC = "the public page shows only what the visitor needs", CLOSED = "a page that is not live, deleted, in a read-only workspace, or without a daily cap takes no bookings";
const LIST = "agents list bookings over REST, by page and time, and see people only as far as they may", OWNER = "the owner lists a page's bookings upcoming first and cancels one, which frees the time";
const HOLD = "a payment hold frees its time after 30 minutes, and the cron marks it expired", HOOK = "a webhook with no secret, a bad signature, a stale time or another workspace's secret writes nothing";
const PAID = "a paid event confirms the booking once, with the amount from the event, even when delivered twice", SECRET = "the signing secret is write-only and the card shows the webhook address";
const MAIL = "a confirmed booking lands on the person's timeline and emails the booker and the owner";
const row = (id, kind, visibility, writes, principal, readonly, masks, proof, reason) => ({ id, kind, visibility, writes, principal, readonly, masks, proof, ...(reason ? { reason } : {}) });
const settle = "a payment Stripe already took is recorded so the owner can refund it; timeline entries and emails are skipped in a read-only workspace";
const rows = [
  row("agentApi:bookings", "query", "internal", false, "agent", "not-a-write", "projected", LIST),
  row("HTTP GET /api/v1/bookings", "route", "http", false, "agent", "not-a-write", "projected", LIST),
  row("bookings:page", "query", "public", false, "human", "not-a-write", "projected", PUBLIC, "public: no sign-in; only the page's name, description, length, price and open times"),
  row("bookings:book", "mutation", "public", true, "human", "refused", "no-record-data", CLOSED, "public: no sign-in; a read-only workspace's pages take no bookings"),
  row("bookings:forPage", "query", "public", false, "human", "not-a-write", "projected", OWNER),
  row("bookings:cancel", "mutation", "public", true, "human", "refused", "n/a", READONLY),
  row("bookings:paymentSettings", "query", "public", false, "human", "not-a-write", "no-record-data", SECRET),
  row("bookings:savePaymentSecret", "mutation", "public", true, "human", "refused", "n/a", READONLY),
  row("bookings:expire", "mutation", "internal", true, "human", "reduction-only", "no-record-data", HOLD, "only ends holds that ran out"),
  row("bookings:secretFor", "query", "internal", false, "human", "not-a-write", "no-record-data", HOOK, "webhook verification only"),
  row("bookings:stripeWebhook", "httpaction", "http", true, "human", "settlement-allowed", "no-record-data", HOOK, settle),
  row("bookings:paid", "mutation", "internal", true, "human", "settlement-allowed", "no-record-data", PAID, settle),
  row("bookings:mailFor", "query", "internal", false, "human", "not-a-write", "no-record-data", MAIL, "booking emails only"),
  row("bookings:notify", "action", "internal", true, "human", "refused", "no-record-data", MAIL, "sends through campaign email's one-off sender, which refuses a read-only workspace"),
  row("bookings:hookToken", "mutation", "internal", true, "human", "reduction-only", "no-record-data", "the Stripe webhook is rate limited per workspace", "rate limit bookkeeping only"),
  row("bookings:failed", "mutation", "internal", true, "human", "reduction-only", "no-record-data", "a delayed payment confirms when it succeeds and frees the time when it fails", "only ends a hold whose payment failed"),
  row("cron Expire booking holds", "cron", "cron", true, "scheduler", "reduction-only", "no-record-data", HOLD, "only ends holds that ran out"),
];
const known = new Set(inventory.map((entry) => entry.id));
writeFileSync(path, JSON.stringify([...inventory, ...rows.filter((r) => !known.has(r.id))], null, 2) + "\n");
