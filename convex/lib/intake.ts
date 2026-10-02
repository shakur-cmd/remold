declare const process: { env: Record<string, string | undefined> };
import { v } from "convex/values";
import { DAY } from "@convex-dev/rate-limiter";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { fail } from "../errors";
import { fieldGranted, requireMember, type AgentMembership } from "../identity";
import { writable } from "../authority/readonly";
import { issue } from "../authority/grants";
import { notice } from "../alerts";
import { intakeLimiter } from "../rateLimit";
import { applyChange } from "./applyChange";
import { remember, replay, type Idempotency } from "./idempotency";

// Website lead intake: one call finds or creates the Person, creates an Opportunity
// at "new" and a Note with the message, all in the caller's single transaction.
export const leadArgs = { name: v.string(), email: v.string(), phone: v.optional(v.string()), company: v.optional(v.string()), message: v.optional(v.string()), source: v.optional(v.string()), campaign: v.optional(v.string()) };
type Lead = { name: string; email: string; phone?: string; company?: string; message?: string; source?: string; campaign?: string };
type Item = { object: Doc<"objects">; fields: Record<string, Doc<"fields">> };

// The intake key holds exactly these direct field grants and no read scope.
const GRANTS = [
  { action: "create", object: "person", fields: ["name", "email", "phone", "company"] },
  { action: "create", object: "company", fields: ["name"] },
  { action: "create", object: "opportunity", fields: ["name", "stage", "person", "company"] },
  { action: "create", object: "note", fields: ["body", "about"] },
] as const;
const GRANT_MS = 5 * 365 * DAY;

export const normalEmail = (value: string) => value.trim().toLowerCase();
export const normalPhone = (value: string) => { const digits = value.replace(/\D/g, ""); return digits ? (value.trim().startsWith("+") ? "+" : "") + digits : undefined; };
const text = (value: string | undefined, label: string, max = 200) => { const t = value?.trim() ?? ""; if (t.length > max) fail("VALIDATION", `${label} is too long`); return t || undefined; };
// A missing or unreadable cap means zero (AGENTS.md), so intake takes no leads until it is set.
const dailyCap = () => { const raw = process.env.REMOLD_INTAKE_DAILY_CAP?.trim(), n = Number(raw); return raw && Number.isSafeInteger(n) && n > 0 ? n : 0; };

async function intakeScopes(ctx: MutationCtx, orgId: Id<"orgs">) {
  const items: Record<string, Item> = {};
  for (const key of ["person", "company", "opportunity", "note"]) {
    const object = await ctx.db.query("objects").withIndex("by_org_key", (q) => q.eq("orgId", orgId).eq("key", key)).unique();
    if (!object) fail("NOT_FOUND", `Website intake needs the ${key} object`);
    const fields = await ctx.db.query("fields").withIndex("by_object", (q) => q.eq("orgId", orgId).eq("objectId", object._id)).collect();
    items[key] = { object, fields: Object.fromEntries(fields.filter((field) => !field.retired).map((field) => [field.key, field])) };
  }
  const scopes = GRANTS.map((grant) => ({ action: grant.action, object: items[grant.object]!.object, fieldIds: grant.fields.map((key) => items[grant.object]!.fields[key]?._id ?? fail("NOT_FOUND", `Website intake needs ${grant.object}.${key}`)) }));
  return { items, scopes };
}

export async function grantIntake(ctx: MutationCtx, orgId: Id<"orgs">, agentId: Id<"agents">) {
  const owner = await requireMember(ctx, orgId, "owner");
  for (const scope of (await intakeScopes(ctx, orgId)).scopes) await issue(ctx, owner, { target: agentId, capability: `record.${scope.action}`, scope: { kind: "records", objectId: scope.object._id, records: "all", fields: scope.fieldIds }, mode: "direct", delegate: false, expiresAt: Date.now() + GRANT_MS });
}

// Stored values keep whatever formatting people typed, so both sides are normalized
// before comparing. A scan of People is fine at current scale; earliest record wins.
// Find-or-create must prove absence, so this is an exhaustive exact match on the
// normalized title within one object, never a ranked, truncated search.
async function companyNamed(ctx: MutationCtx, item: Item, name: string) {
  const want = name.trim().toLowerCase();
  for await (const record of ctx.db.query("records").withIndex("by_object", (q) => q.eq("orgId", item.object.orgId).eq("objectId", item.object._id))) if (record.title.trim().toLowerCase() === want) return record;
  return null;
}

async function matches(ctx: MutationCtx, item: Item, email: string, phone?: string) {
  const emailId = item.fields.email!._id, phoneId = item.fields.phone!._id;
  let byEmail: Doc<"records"> | null = null, byPhone: Doc<"records"> | null = null;
  for await (const record of ctx.db.query("records").withIndex("by_object", (q) => q.eq("orgId", item.object.orgId).eq("objectId", item.object._id))) {
    const storedEmail = record.values[emailId], storedPhone = record.values[phoneId];
    if (!byEmail && typeof storedEmail === "string" && normalEmail(storedEmail) === email) byEmail = record;
    if (!byPhone && phone && typeof storedPhone === "string" && normalPhone(storedPhone) === phone) byPhone = record;
    if (byEmail && (byPhone || !phone)) break;
  }
  return { byEmail, byPhone };
}

// Over-limit leads write no records; the operator hears once an hour per limit, with the
// workspace id (opaque) in the key and no contact data. The daily window is anchored at UTC midnight.
async function overLimit(ctx: MutationCtx, principal: AgentMembership, email: string) {
  const orgId = principal.org._id, cap = dailyCap();
  const checks = [
    ["key", () => intakeLimiter.limit(ctx, "intakeKey", { key: principal.agent._id })],
    ["email", () => intakeLimiter.limit(ctx, "intakeEmail", { key: `${orgId}:${email}` })],
    ["daily", async () => cap > 0 ? intakeLimiter.limit(ctx, "intakeDaily", { key: orgId, config: { kind: "fixed window", rate: cap, period: DAY, start: 0 } }) : { ok: false, retryAfter: DAY - (Date.now() % DAY) }],
  ] as const;
  for (const [which, take] of checks) {
    const result = await take();
    if (result.ok) continue;
    if ((await intakeLimiter.limit(ctx, "intakeAlert", { key: `${orgId}:${which}` })).ok) await ctx.db.insert("opsNotices", { payload: notice("open", { key: `intake-limit:${orgId}:${which}`, kind: "intake-limit", fn: which, count: 1 }, Date.now()), attempts: 0 });
    return { retryAfter: Math.max(1, Math.ceil((result.retryAfter ?? 0) / 1000)) };
  }
  return null;
}

export async function submitLead(ctx: MutationCtx, principal: AgentMembership, input: Lead, request?: Idempotency): Promise<{ opportunity: { id: Id<"records">; ref: string | null } } | { limited: { retryAfter: number } }> {
  const orgId = principal.org._id;
  await writable(ctx, orgId);
  const { items, scopes } = await intakeScopes(ctx, orgId);
  // New-style field grants only: a legacy create:x grant never authorizes intake.
  if (!scopes.every((scope) => fieldGranted(principal, scope.action, scope.object, undefined, scope.fieldIds))) fail("FORBIDDEN", "Website intake grant required");
  if (!request) fail("VALIDATION", "Idempotency-Key header is required");
  const prior = await replay(ctx, principal.agent._id, request);
  if (prior) return prior.result;
  const name = text(input.name, "Name"), email = normalEmail(input.email), phone = input.phone ? normalPhone(input.phone) : undefined;
  const company = text(input.company, "Company"), message = text(input.message, "Message", 5000), source = text(input.source, "Source") ?? "website", campaign = text(input.campaign, "Campaign");
  if (!name) fail("VALIDATION", "Name is required");
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("VALIDATION", "A valid email is required");
  if (phone && phone.length > 20) fail("VALIDATION", "Phone is too long");
  const limited = await overLimit(ctx, principal, email);
  if (limited) return { limited };

  const { person, company: companies, opportunity, note } = items as Record<"person" | "company" | "opportunity" | "note", Item>;
  const reason = `Website lead (${source})`;
  const ids = (item: Item, values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => [item.fields[key]!._id, value]));
  const create = async (item: Item, values: Record<string, unknown>) => (await applyChange(ctx, principal, { action: "create", orgId, objectId: item.object._id, values: ids(item, values), reason }, { writeOnly: true })).recordId;

  const companyId = company ? (await companyNamed(ctx, companies, company))?._id ?? await create(companies, { name: company }) : undefined;
  const { byEmail, byPhone } = await matches(ctx, person, email, phone);
  // Email wins. A public form never changes an existing Person: a match is only linked,
  // and what was submitted stays in the Note. A phone that belongs to someone else is flagged.
  const conflict = byEmail && byPhone && byEmail._id !== byPhone._id ? byPhone : null;
  const personId = (byEmail ?? byPhone)?._id ?? await create(person, { name, email, phone, company: companyId });

  const opportunityId = await create(opportunity, { name: `${name} (${source})`, stage: "new", person: personId, company: companyId });
  const body = [message ?? "(no message)", "", `Source: ${source}`, ...(campaign ? [`Campaign: ${campaign}`] : []), `Submitted: ${[name, email, phone, company].filter(Boolean).join(", ")}`,
    ...(conflict ? [`Not merged: the phone ${phone} belongs to ${conflict.title || "another person"}${conflict.ref ? ` (${conflict.ref})` : ""}, not to the person this email matched. Check which person this is.`] : [])].join("\n");
  await create(note, { body, about: opportunityId });
  const created = await ctx.db.get(opportunityId);
  return remember(ctx, orgId, principal.agent._id, request, { opportunity: { id: opportunityId, ref: created?.ref ?? null } });
}
