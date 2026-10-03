import type { Send } from "./tools.js";

// The stdio server's way to Remold: each tool's REST request over HTTP with the agent key.
export function httpSend(options: { url: string; key: string; fetch?: typeof fetch }): Send {
  return async ({ method, path, body, idempotencyKey }) => {
    const response = await (options.fetch ?? fetch)(`${options.url.replace(/\/$/, "")}/api/v1${path}`, { method, headers: { authorization: `Bearer ${options.key}`, ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() };
  };
}
