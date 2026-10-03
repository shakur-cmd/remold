// Adds the campaign email rows to ops/authority/inventory.json (run once from the repo root).
import { readFileSync, writeFileSync } from "node:fs";
const path = "ops/authority/inventory.json", inventory = JSON.parse(readFileSync(path, "utf8"));
const READONLY = "Readonly workspace refuses every public human write and every agent REST write", MASKS = "Hidden field value never appears in any human query or agent REST read";
const REPORT = "the report shows each email's numbers and gate problems, and recipients only as far as the key may read", PREVIEW = "previews an email for one person with who would get it and who is left out", MARK = "an agent that can read the campaign marks a recipient replied, which keeps follow-ups from them";
const SEND = "sends an approved email once to each person on an active campaign, with footer, unsubscribe headers and a timeline entry", WEBHOOK = "refuses a missing secret, a bad or foreign signature and a stale timestamp, writing nothing, and counts a replayed event once";
const UNSUB = "the unsubscribe link asks first; only the button unsubscribes, once, and an unknown link looks the same", REPLY = "a reply to the inbound address marks the send replied, keeps the reply as a note and forwards it to the org", ONE = "sends one email through the same gates and daily limits";
const row = (id, kind, visibility, writes, principal, readonly, masks, proof, reason) => ({ id, kind, visibility, writes, principal, readonly, masks, proof, ...(reason ? { reason } : {}) });
const sender = "campaign email sender; a read-only workspace sends nothing", optOut = "opting out and bounce suppression always apply, even in a read-only workspace";
const rows = [
  row("agentApi:campaignReport", "query", "internal", false, "agent", "not-a-write", "projected", REPORT),
  row("agentApi:emailPreview", "query", "internal", false, "agent", "not-a-write", "projected", PREVIEW),
  row("agentApi:markReplied", "mutation", "internal", true, "agent", "refused", "n/a", MARK),
  row("HTTP GET /api/v1/campaigns/:id/report", "route", "http", false, "agent", "not-a-write", "projected", REPORT),
  row("HTTP GET /api/v1/emails/:id/preview", "route", "http", false, "agent", "not-a-write", "projected", PREVIEW),
  row("HTTP POST /api/v1/sends/:id/replied", "route", "http", true, "agent", "refused", "no-record-data", READONLY),
  row("campaigns:settings", "query", "public", false, "human", "not-a-write", "no-record-data", MASKS),
  row("campaigns:report", "query", "public", false, "human", "not-a-write", "projected", MASKS),
  row("campaigns:preview", "query", "public", false, "human", "not-a-write", "projected", MASKS),
  row("campaigns:saveSettings", "mutation", "public", true, "human", "refused", "n/a", READONLY),
  row("campaigns:approve", "mutation", "public", true, "human", "refused", "n/a", READONLY),
  row("campaigns:markReplied", "mutation", "public", true, "human", "refused", "n/a", READONLY),
  row("campaignSend:claim", "mutation", "internal", true, "human", "refused", "no-record-data", "a claim whose sender crashed is retried with the same idempotency key after its lease, so nobody gets it twice", sender),
  row("campaignSend:begin", "mutation", "internal", true, "human", "refused", "no-record-data", "stops the rest of a batch when the campaign is paused mid-batch, and finishes after it restarts", sender),
  row("campaignSend:finish", "mutation", "internal", true, "human", "refused", "no-record-data", SEND, sender),
  row("campaignSend:tick", "action", "internal", true, "human", "refused", "no-record-data", SEND, sender),
  row("campaignSend:seen", "query", "internal", false, "human", "not-a-write", "no-record-data", REPLY, "webhook bookkeeping only"),
  row("campaignSend:track", "mutation", "internal", true, "human", "reduction-only", "no-record-data", WEBHOOK, optOut),
  row("campaignSend:replied", "mutation", "internal", true, "human", "reduction-only", "no-record-data", REPLY, optOut),
  row("campaignSend:unsubscribe", "mutation", "internal", true, "human", "reduction-only", "no-record-data", UNSUB, optOut),
  row("campaignSend:resendWebhook", "httpaction", "http", true, "human", "reduction-only", "no-record-data", WEBHOOK, optOut),
  row("campaignSend:unsubscribePage", "httpaction", "http", true, "human", "reduction-only", "no-record-data", UNSUB, optOut),
  row("campaignSend:reserveOne", "mutation", "internal", true, "human", "refused", "no-record-data", ONE, sender),
  row("campaignSend:releaseOne", "mutation", "internal", true, "human", "reduction-only", "no-record-data", ONE, sender),
  row("campaignSend:transactional", "action", "internal", true, "human", "refused", "no-record-data", ONE, sender),
  row("cron Campaign email", "cron", "cron", true, "scheduler", "refused", "no-record-data", "runs the sender every minute", sender),
];
const known = new Set(inventory.map((entry) => entry.id));
writeFileSync(path, JSON.stringify([...inventory, ...rows.filter((r) => !known.has(r.id))], null, 2) + "\n");
