import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { recordResponse, validProbe } from "./telemetryHttp";

const router = httpRouter();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const statusFor: Record<string, number> = { UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, VALIDATION: 400, UNSUPPORTED: 400, UNINDEXED_FIELD: 400 };
const hash = async (key: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const bad = (code: string, message: string, status = statusFor[code] ?? 400) => json({ error: { code, message } }, status);
const number = (value: string | null) => { const n = value === null ? NaN : Number(value); return Number.isFinite(n) ? n : undefined; };

async function auth(request: Request) {
  const token = /^Bearer (rm_[0-9a-f]{40})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) throw { data: { code: "UNAUTHENTICATED", message: "Missing or malformed agent key" } };
  return hash(token);
}

async function dispatch(ctx: any, request: Request) {
  if(request.method === "GET" && new URL(request.url).pathname === "/api/v1/_probe") return await validProbe(request) ? json({ok:true}) : bad("UNAUTHENTICATED", "Invalid probe", 401);
  const keyHash = await auth(request), url = new URL(request.url), path = url.pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean), q = url.searchParams;
  const limit = request.method === "POST" ? await ctx.runMutation(internal.rateLimit.take, { keyHash }) : { allowed: true, retryAfter: 0 };
  if (!limit.allowed) return new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "Agent write limit reached. Retry after the indicated delay.", retryAfter: limit.retryAfter } }), { status: 429, headers: { "content-type": "application/json", "retry-after": String(limit.retryAfter) } });
  const body = request.method === "POST" ? request.headers.get("content-type")?.includes("application/json") ? await request.json().catch(() => { throw { data: { code: "VALIDATION", message: "Expected JSON body" } }; }) : {} : undefined;
  // keyHash goes last so nothing in a request body can replace the identity the header proved.
  const query = (reference: any, args: any) => ctx.runQuery(reference, { ...args, keyHash });
  const mutation = (reference: any, args: any) => ctx.runMutation(reference, { ...args, keyHash });
  if (request.method === "GET" && path[0] === "me" && path.length === 1) return json(await query(internal.agentApi.me, {}));
  if (request.method === "GET" && path[0] === "objects" && path.length === 1) return json(await query(internal.agentApi.objects, {}));
  if (request.method === "GET" && path[0] === "records" && path.length === 1) return json(await query(internal.agentApi.listRecords, { object: q.get("object") ?? "", cursor: q.get("cursor") ?? undefined, limit: number(q.get("limit")), ...(q.get("sort") ? { sort: { field: q.get("sort"), direction: q.get("direction") ?? "asc" } } : {}), ...(q.get("filter") ? { filter: { field: q.get("filter"), value: q.get("value") } } : {}) }));
  if (request.method === "GET" && path[0] === "records" && path.length === 2) return json(await query(internal.agentApi.getRecord, { idOrRef: path[1] }));
  if (request.method === "GET" && path[0] === "records" && path[2] === "events" && path.length === 3) return json((await query(internal.agentApi.getRecord, { idOrRef: path[1] })).events);
  if (request.method === "GET" && path[0] === "records" && path[2] === "related" && path.length === 3) return json(await query(internal.agentApi.related, { idOrRef: path[1], field: q.get("field") ?? "" }));
  if (request.method === "GET" && path[0] === "search" && path.length === 1) return json(await query(internal.agentApi.search, { q: q.get("q") ?? "", object: q.get("object") ?? undefined, limit: number(q.get("limit")) }));
  if (request.method === "GET" && path[0] === "today" && path.length === 1) return json(await query(internal.agentApi.today, {}));
  if (request.method === "GET" && path[0] === "suggestions" && path.length === 1) return json(await query(internal.agentApi.listSuggestions, { status: q.get("status") ?? undefined }));
  if (request.method === "POST" && path[0] === "suggestions" && path.length === 1) return json(await mutation(internal.agentApi.propose, body), 201);
  if (request.method === "POST" && path[0] === "changes" && path.length === 1) return json(await mutation(internal.agentApi.change, body));
  if (request.method === "GET" && path[0] === "inbox" && path.length === 1) return json(await query(internal.agentApi.inbox, { status: q.get("status") ?? undefined }));
  if (request.method === "POST" && path[0] === "inbox" && path.length === 1) return json(await mutation(internal.agentApi.inboxAdd, body), 201);
  if (request.method === "POST" && path[0] === "inbox" && path[2] === "resolve" && path.length === 3) return json(await mutation(internal.agentApi.inboxResolve, { id: path[1], ...body }));
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
const route = httpAction(async (ctx,request) => {
  const startedAt=Date.now();
  const response=await responseFor(ctx,request);
  await recordResponse(ctx,request,response,startedAt);
  return response;
});
router.route({ pathPrefix: "/api/v1/", method: "GET", handler: route });
router.route({ pathPrefix: "/api/v1/", method: "POST", handler: route });
export default router;
