import { getFunctionName, httpRouter, makeFunctionReference } from "convex/server";
import { argumentsConform } from "./lib/shape";
import { trialOf } from "./lib/blueprint";
import * as agentApi from "./agentApi";
import * as commands from "./integrations/commands";
import * as grants from "./authority/grants";
import { route as integrationRoute } from "./integrations/http";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { recordResponse, validProbe } from "./telemetryHttp";
import { resendWebhook, unsubscribePage } from "./campaignSend";
import { stripeWebhook } from "./bookings";
import { mcp } from "./mcp";

const router = httpRouter();
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const statusFor: Record<string, number> = { AUTHORITY_MIGRATING: 503, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, IDEMPOTENCY_MISMATCH: 422, VALIDATION: 400, UNSUPPORTED: 400, UNINDEXED_FIELD: 400, SLOTS_EXHAUSTED: 409 };
const hash = async (key: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const bad = (code: string, message: string, status = statusFor[code] ?? 400) => json({ error: { code, message } }, status);
const number = (value: string | null) => { const n = value === null ? NaN : Number(value); return Number.isFinite(n) ? n : undefined; };

// filter[field]=value (repeatable, AND) and range[field]=from..to (either end may be empty; one date alone is that day).
function listQuery(q: URLSearchParams) {
  const named = (kind: string) => [...q].flatMap(([key, value]) => { const field = new RegExp(`^${kind}\\[(.+)\\]$`).exec(key)?.[1]; return field ? [{ field, value }] : []; });
  const filters = named("filter"), ranges = named("range");
  if (ranges.length > 1) throw { data: { code: "UNSUPPORTED", message: "One range per request" } };
  const parts = ranges[0]?.value.split(".."), [from, to = from] = parts ?? [];
  if (parts && parts.length > 2) throw { data: { code: "VALIDATION", message: "Expected range[field]=from..to" } };
  const range = ranges[0] && { field: ranges[0].field, ...(from ? { from } : {}), ...(to ? { to } : {}) };
  return { ...(filters.length ? { filters } : {}), ...(range ? { range } : {}) };
}

async function auth(request: Request) {
  const token = /^Bearer (rm_[0-9a-f]{40})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) throw { data: { code: "UNAUTHENTICATED", message: "Missing or malformed agent key" } };
  return hash(token);
}

// ADR 002: a key is bound to a hash of the route and canonical (key-sorted) body.
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as any)[key])}`).join(",")}}` : JSON.stringify(value) ?? "null";
async function idempotencyOf(request: Request, path: string, body: unknown) {
  const key = request.headers.get("idempotency-key");
  if (key === null) return undefined;
  if (!/^[\x21-\x7e]{1,255}$/.test(key)) throw { data: { code: "VALIDATION", message: "Idempotency-Key must be 1 to 255 visible ASCII characters" } };
  return { key, hash: await hash(`${path}\n${canonical(body)}`) };
}
const intakeReply = (result: any): [unknown, number, Record<string, string>?] => result.limited ? [{ error: { code: "RATE_LIMITED", message: "Lead intake limit reached. Retry after the indicated delay.", retryAfter: result.limited.retryAfter } }, 429, { "retry-after": String(result.limited.retryAfter) }] : [result, 201];

// A blueprint is first applied in a transaction that always rolls back, so it is refused now if it would be refused later.
async function tried(mutation: (reference: any, args: any) => Promise<unknown>, body: any) {
  if (body?.kind === "blueprint") await trialOf(() => mutation(internal.agentApi.trialBlueprint, { blueprint: body.blueprint }));
  return body;
}

async function dispatch(ctx: any, request: Request) {
  if(request.method === "GET" && new URL(request.url).pathname === "/api/v1/_probe") return await validProbe(request) ? json({ok:true}) : bad("UNAUTHENTICATED", "Invalid probe", 401);
  const keyHash = await auth(request), url = new URL(request.url), path = url.pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean), q = url.searchParams;
  const limit = request.method === "POST" && path[0] !== "intake" ? await ctx.runMutation(internal.rateLimit.take, { keyHash }) : { allowed: true, retryAfter: 0 };
  if (!limit.allowed) return new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "Agent write limit reached. Retry after the indicated delay.", retryAfter: limit.retryAfter } }), { status: 429, headers: { "content-type": "application/json", "retry-after": String(limit.retryAfter) } });
  const body = request.method === "POST" ? request.headers.get("content-type")?.includes("application/json") ? await request.json().catch(() => { throw { data: { code: "VALIDATION", message: "Expected JSON body" } }; }) : {} : undefined;
  // keyHash goes last so nothing in a request body can replace the identity the header proved.
  // Intake keys are limited inside the intake call, where an over-limit lead can raise an alert.
  // Malformed bodies are refused before the call: Convex would log every argument, keyHash included.
  const modules: Record<string, Record<string, unknown>> = { agentApi, "integrations/commands": commands, "authority/grants": grants };
  const checked = async (reference: any, args: any) => {
    const [module, name] = getFunctionName(reference).split(":"), ids = argumentsConform(modules[module!]?.[name!], args);
    if (!ids || (ids.length && !await ctx.runQuery(makeFunctionReference<"query">("lib/shape:idsBelong"), { ids }))) throw { data: { code: "VALIDATION", message: "Invalid request body for this route" } };
    return args;
  };
  const query = async (reference: any, args: any) => ctx.runQuery(reference, await checked(reference, { ...args, keyHash }));
  const mutation = async (reference: any, args: any) => ctx.runMutation(reference, await checked(reference, { ...args, ...(["propose", "proposeShape", "inboxAdd", "inboxResolve", "markReplied"].some(n => getFunctionName(reference) === `agentApi:${n}`) ? { idempotency: await idempotencyOf(request, url.pathname, body) } : {}), keyHash }));
  if (path[0] === "operations") {
    if (request.method === "GET" && path.length === 2) return json(await query(makeFunctionReference<'query'>("integrations/commands:getAgent"), { id: path[1] }));
    if (request.method === "POST" && path.length === 1) return json(await mutation(makeFunctionReference<'mutation'>("integrations/commands:proposeAgent"), body), 201);
    const commands: Record<string, string> = { edit: "editAgent", claim: "claimAgent", cancel: "cancelAgent" };
    if (request.method === "POST" && path.length === 3 && commands[path[2]]) return json(await mutation(makeFunctionReference<'mutation'>("integrations/commands:" + commands[path[2]]), { ...body, id: path[1] }));
  }
  if (path[0] === "authority" && request.method === "POST" && path.length === 2) {
    const commands: Record<string, string> = { grant: "grantAgent", revoke: "revokeAgent", fire: "fireAgent" };
    if (commands[path[1]]) return json(await mutation(makeFunctionReference<'mutation'>("authority/grants:" + commands[path[1]]), body));
  }
  if (request.method === "GET" && path[0] === "me" && path.length === 1) return json(await query(internal.agentApi.me, {}));
  if (request.method === "GET" && path[0] === "map" && path.length === 1) return json(await query(internal.agentApi.map, {}));
  if (request.method === "GET" && path[0] === "objects" && path.length === 1) return json(await query(internal.agentApi.objects, q.get("include") === "archived" ? { includeArchived: true } : {}));
  if (request.method === "GET" && path[0] === "records" && path.length === 1) return json(await query(internal.agentApi.listRecords, { object: q.get("object") ?? "", cursor: q.get("cursor") ?? undefined, limit: number(q.get("limit")), ...(q.get("sort") ? { sort: { field: q.get("sort"), direction: q.get("direction") ?? "asc" } } : {}), ...(q.get("filter") ? { filter: { field: q.get("filter"), value: q.get("value") } } : {}), ...listQuery(q) }));
  if (request.method === "GET" && path[0] === "records" && path.length === 2) return json(await query(internal.agentApi.getRecord, { idOrRef: path[1] }));
  if (request.method === "GET" && path[0] === "records" && path[2] === "events" && path.length === 3) return json(await query(internal.agentApi.getRecord, { idOrRef: path[1], cursor: q.get("cursor") ?? undefined, limit: number(q.get("limit")) }).then(({ events, nextCursor }) => ({ events, nextCursor })));
  if (request.method === "GET" && path[0] === "records" && path[2] === "related" && path.length === 3) return json(await query(internal.agentApi.related, { idOrRef: path[1], field: q.get("field") ?? "" }));
  if (request.method === "GET" && path[0] === "search" && path.length === 1) return json(await query(internal.agentApi.search, { q: q.get("q") ?? "", object: q.get("object") ?? undefined, limit: number(q.get("limit")) }));
  if (request.method === "GET" && path[0] === "today" && path.length === 1) return json(await query(internal.agentApi.today, {}));
  if (request.method === "GET" && path[0] === "my-tasks" && path.length === 1) return json(await query(internal.agentApi.myTasks, { cursor: q.get("cursor") ?? undefined, limit: number(q.get("limit")) }));
  if (request.method === "GET" && path[0] === "suggestions" && path.length === 1) return json(await query(internal.agentApi.listSuggestions, { status: q.get("status") ?? undefined }));
  if (request.method === "POST" && path[0] === "suggestions" && path.length === 1) return json(await mutation(internal.agentApi.propose, body), 201);
  if (request.method === "POST" && path[0] === "changes" && path.length === 1) return json(await mutation(internal.agentApi.change, { ...body, idempotency: await idempotencyOf(request, url.pathname, body) }));
  if (request.method === "POST" && path[0] === "batches" && path.length === 1) return json(await mutation(internal.agentApi.proposeBatch, { ...body, idempotency: await idempotencyOf(request, url.pathname, body) }), 201);
  if (request.method === "GET" && path[0] === "batches" && path.length === 2) return json(await query(internal.agentApi.batchStatus, { id: path[1], cursor: q.get("cursor") ?? undefined, limit: number(q.get("limit")) }));
  if (request.method === "GET" && path[0] === "shape" && path[1] === "proposals" && path.length === 2) return json(await query(internal.agentApi.shapeProposals, { status: q.get("status") ?? undefined }));
  if (request.method === "POST" && path[0] === "shape" && path[1] === "proposals" && path.length === 2) return json(await mutation(internal.agentApi.proposeShape, await tried(mutation, body)), 201);
  if (request.method === "GET" && path[0] === "blueprints" && path.length === 1) return json(await query(internal.agentApi.blueprints, {}));
  if (request.method === "GET" && path[0] === "blueprints" && path[1] === "current" && path.length === 2) return json(await query(internal.agentApi.currentBlueprint, {}));
  if (request.method === "GET" && path[0] === "views" && path.length === 1) return json(await query(internal.agentApi.views, { object: q.get("object") ?? undefined }));
  if (request.method === "GET" && path[0] === "views" && path[2] === "records" && path.length === 3) return json(await query(internal.agentApi.viewRecords, { id: path[1], cursor: q.get("cursor") ?? undefined, limit: number(q.get("limit")), tz: q.get("tz") ?? undefined }));
  if (request.method === "GET" && path[0] === "inbox" && path.length === 1) return json(await query(internal.agentApi.inbox, { status: q.get("status") ?? undefined }));
  if (request.method === "POST" && path[0] === "inbox" && path.length === 1) return json(await mutation(internal.agentApi.inboxAdd, body), 201);
  if (request.method === "POST" && path[0] === "inbox" && path[2] === "resolve" && path.length === 3) return json(await mutation(internal.agentApi.inboxResolve, { id: path[1], ...body }));
  if (request.method === "GET" && path[0] === "campaigns" && path[2] === "report" && path.length === 3) return json(await query(internal.agentApi.campaignReport, { idOrRef: path[1] }));
  if (request.method === "GET" && path[0] === "emails" && path[2] === "preview" && path.length === 3) return json(await query(internal.agentApi.emailPreview, { idOrRef: path[1], ...(q.get("person") ? { person: q.get("person") } : {}) }));
  if (request.method === "GET" && path[0] === "bookings" && path.length === 1) return json(await query(internal.agentApi.bookings, Object.fromEntries(["page", "from", "to"].flatMap((key) => (q.get(key) ? [[key, q.get(key)]] : [])))));
  if (request.method === "GET" && path[0] === "automations" && path[2] === "runs" && path.length === 3) return json(await query(internal.agentApi.automationRuns, { idOrRef: path[1] }));
  if (request.method === "POST" && path[0] === "automations" && path[2] === "test" && path.length === 3) return json(await query(internal.agentApi.automationTest, { idOrRef: path[1], ...(body?.record !== undefined ? { record: body.record } : {}) }));
  if (request.method === "POST" && path[0] === "sends" && path[2] === "replied" && path.length === 3) return json(await mutation(internal.agentApi.markReplied, { id: path[1] }));
  if (path[0] === "intake" && request.method === "POST" && path.length === 2) {
    const commands: Record<string, string> = { lead: "intakeLead" };
    if (commands[path[1]]) return json(...intakeReply(await mutation(makeFunctionReference<'mutation'>("agentApi:" + commands[path[1]]), { ...body, idempotency: await idempotencyOf(request, url.pathname, body) })));
  }
  return bad("NOT_FOUND", "Route not found", 404);
}

async function responseFor(ctx: any, request: Request) {
  try { return await dispatch(ctx, request); }
  catch (error) {
    const data = (error as any)?.data;
    if (data?.code) return json({ error: data }, statusFor[data.code] ?? 500);
    // A body that fails the function's validator is the caller's mistake, not ours.
    const message = String((error as any)?.message ?? "");
    if (/ArgumentValidationError|Validator error/.test(message)) return bad("VALIDATION", message.split("\n").slice(0, 2).join(" ").trim());
    return bad("INTERNAL", "Something went wrong", 500);
  }
}
const measured = (handle: (ctx: any, request: Request) => Promise<Response>) => httpAction(async (ctx,request) => {
  const startedAt=Date.now();
  const response=await handle(ctx,request);
  await recordResponse(ctx,request,response,startedAt);
  return response;
});
const route = measured(responseFor);
router.route({ pathPrefix: "/api/v1/", method: "GET", handler: route });
router.route({ pathPrefix: "/api/v1/", method: "POST", handler: route });
const mcpRoute = measured((ctx, request) => mcp(ctx, request, { keyHash: () => auth(request), run: (inner) => responseFor(ctx, inner) }));
for (const method of ["GET", "POST", "DELETE"] as const) router.route({ path: "/mcp", method, handler: mcpRoute });
router.route({ pathPrefix: "/api/integrations/v1/", method: "POST", handler: integrationRoute });
router.route({ path: "/webhooks/resend", method: "POST", handler: resendWebhook });
router.route({ pathPrefix: "/webhooks/stripe/", method: "POST", handler: stripeWebhook });
router.route({ pathPrefix: "/u/", method: "GET", handler: unsubscribePage });
router.route({ pathPrefix: "/u/", method: "POST", handler: unsubscribePage });
export default router;
