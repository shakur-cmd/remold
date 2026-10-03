import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { callTool, capabilities, instructions, serverInfo, toolList, type Rest } from "../packages/mcp/src/tools";

// Streamable HTTP, stateless JSON-response mode (MCP 2025-03-26 to 2025-11-25): one JSON-RPC message per POST,
// one JSON reply, no sessions and no SSE. Tool calls run the REST router in-process, so a hosted call has the
// same key check, rate limit, argument checks, permissions and errors as /api/v1.
const versions = ["2025-11-25", "2025-06-18", "2025-03-26"];
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const error = (id: unknown, code: number, message: string, status = 200, headers: Record<string, string> = {}) => reply({ jsonrpc: "2.0", id, error: { code, message } }, status, headers);
const statusFor: Record<string, number> = { UNAUTHENTICATED: 401, FORBIDDEN: 403, AUTHORITY_MIGRATING: 503 };
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export async function mcp(ctx: ActionCtx, request: Request, rest: { keyHash: () => Promise<string>; run: (request: Request) => Promise<Response> }) {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  // Agents call from servers and CLIs. A browser page has no business here, so any Origin is refused (DNS rebinding).
  if (request.headers.get("origin") !== null) return error(null, -32600, "Browser origins are not allowed", 403);
  try { await ctx.runQuery(internal.agentApi.checkKey, { keyHash: await rest.keyHash() }); }
  catch (thrown) {
    const data = (thrown as { data?: { code?: string; message?: string } }).data, status = statusFor[data?.code ?? ""] ?? 401;
    return error(null, status === 503 ? -32603 : -32001, status === 401 ? data?.message ?? "Invalid or revoked agent key" : data?.message ?? "Forbidden", status, status === 401 ? { "www-authenticate": "Bearer" } : {});
  }
  const version = request.headers.get("mcp-protocol-version");
  if (version !== null && !versions.includes(version)) return error(null, -32600, `Unsupported MCP-Protocol-Version ${version}; supported: ${versions.join(", ")}`, 400);
  let message: unknown;
  try { message = JSON.parse(await request.text()); } catch { return error(null, -32700, "Parse error: expected one JSON-RPC message", 400); }
  if (Array.isArray(message)) return error(null, -32600, "Send one JSON-RPC message per request; batches are not supported", 400);
  const invalid = () => error(null, -32600, "Invalid JSON-RPC message", 400);
  if (!isObject(message) || message.jsonrpc !== "2.0") return invalid();
  const { id, method } = message, validId = typeof id === "string" || Number.isSafeInteger(id);
  if ("id" in message && !validId) return invalid();
  // A client's reply to a server request: an id and exactly one of result or a well-formed error. Nothing to answer.
  if (method === undefined) {
    const failure = message.error, answered = "id" in message && ("result" in message) !== ("error" in message) && (failure === undefined || (isObject(failure) && Number.isSafeInteger(failure.code) && typeof failure.message === "string"));
    return answered ? new Response(null, { status: 202 }) : invalid();
  }
  if (typeof method !== "string" || "result" in message || "error" in message) return invalid();
  if (!("id" in message)) return new Response(null, { status: 202 });
  const params = message.params ?? {};
  if (!isObject(params)) return error(id, -32602, "params must be an object");
  const result = (value: unknown) => reply({ jsonrpc: "2.0", id, result: value });
  if (method === "initialize") {
    const info = params.clientInfo;
    if (typeof params.protocolVersion !== "string" || !isObject(params.capabilities) || !isObject(info) || typeof info.name !== "string" || typeof info.version !== "string") return error(id, -32602, "initialize needs a protocolVersion string, a capabilities object and clientInfo with name and version", 400);
    return result({ protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0], capabilities, serverInfo, instructions });
  }
  if (method === "ping") return result({});
  if (method === "tools/list") return result({ tools: toolList });
  if (method !== "tools/call") return error(id, -32601, `Method not found: ${method}`);
  if (typeof params.name !== "string" || (params.arguments !== undefined && !isObject(params.arguments))) return error(id, -32602, "tools/call needs a tool name and an arguments object");
  const send = async ({ method, path, body, idempotencyKey }: Rest) => {
    const response = await rest.run(new Request(new URL(`/api/v1${path}`, request.url), { method, headers: { authorization: request.headers.get("authorization") ?? "", ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { status: response.status, json: await response.json() };
  };
  const called = await callTool(params.name, params.arguments, send);
  return called ? result(called) : error(id, -32602, `Unknown tool: ${params.name}`);
}
