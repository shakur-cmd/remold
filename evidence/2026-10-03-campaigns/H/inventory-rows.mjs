// Adds the batch rows to ops/authority/inventory.json (run once from the repo root).
import { readFileSync, writeFileSync } from "node:fs";
const path = "ops/authority/inventory.json", inventory = JSON.parse(readFileSync(path, "utf8"));
const READONLY = "Readonly workspace refuses every public human write and every agent REST write";
const OWN = "only the submitting agent reads a batch over REST", SEE = "a member-role person cannot see or apply a batch touching an object they cannot write", STOP = "stops an applying batch when the workspace turns read only and resumes it later";
const row = (id, kind, visibility, writes, principal, readonly, masks, proof, reason) => ({ id, kind, visibility, writes, principal, readonly, masks, proof, ...(reason ? { reason } : {}) });
const driver = "batch driver; a read-only workspace stops the batch before any item is written";
const rows = [
  row("agentApi:proposeBatch", "mutation", "internal", true, "agent", "refused", "n/a", READONLY),
  row("agentApi:batchStatus", "query", "internal", false, "agent", "not-a-write", "projected", OWN),
  row("HTTP POST /api/v1/batches", "route", "http", true, "agent", "refused", "n/a", READONLY),
  row("HTTP GET /api/v1/batches/:id", "route", "http", false, "agent", "not-a-write", "projected", OWN),
  row("batches:list", "query", "public", false, "human", "not-a-write", "projected", SEE),
  row("batches:items", "query", "public", false, "human", "not-a-write", "projected", SEE),
  row("batches:apply", "mutation", "public", true, "human", "refused", "n/a", READONLY),
  row("batches:dismiss", "mutation", "public", true, "human", "reduction-only", "n/a", READONLY),
  row("batches:step", "mutation", "internal", true, "human", "refused", "n/a", STOP, driver),
  row("batches:next", "query", "internal", false, "human", "not-a-write", "no-record-data", STOP, driver),
  row("batches:failItem", "mutation", "internal", true, "human", "refused", "no-record-data", STOP, driver),
  row("batches:count", "mutation", "internal", true, "human", "reduction-only", "no-record-data", "counts the links each delete would clear", "bookkeeping on a batch row; writes no record"),
  row("batches:drive", "action", "internal", true, "human", "refused", "no-record-data", STOP, driver),
];
const known = new Set(inventory.map((entry) => entry.id));
writeFileSync(path, JSON.stringify([...inventory, ...rows.filter((r) => !known.has(r.id))], null, 2) + "\n");
