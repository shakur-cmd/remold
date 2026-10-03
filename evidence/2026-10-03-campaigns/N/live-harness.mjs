// SERVICE check of the hosted MCP endpoint: a scratch copy on an anonymous local Convex backend (`convex dev --local`),
// a real MCP client (TypeScript SDK, StreamableHTTPClientTransport) and the built stdio server against it, then the
// Settings agent key panel in Vite + headless Chrome. Sign-in is a self-signed JWT. Nothing hosted is touched.
// Run from the repo root after `pnpm --dir packages/mcp build`:
//   node evidence/2026-10-03-campaigns/N/live-harness.mjs <path to playwright-core>
import { spawn, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve("."), out = join(root, "evidence/2026-10-03-campaigns/N"), [cloudPort, sitePort, vitePort] = [3690, 3691, 5390];
const scratch = mkdtempSync(join(tmpdir(), "remold-n-")), cli = join(root, "node_modules/convex/bin/main.js");
for (const path of ["convex", "src", "public", "packages/contracts", "packages/mcp/src", "index.html", "vite.config.ts", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", "components.json", "package.json"]) cpSync(join(root, path), join(scratch, path), { recursive: true, filter: (p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx") });
symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), "dir");

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "n", alg: "RS256", use: "sig" }] }, issuer = "https://n-harness.invalid", audience = "n-remold";
writeFileSync(join(scratch, "convex/auth.config.ts"), "export default " + JSON.stringify({ providers: [{ type: "customJwt", issuer, applicationID: audience, algorithm: "RS256", jwks: "data:text/plain;charset=utf-8;base64," + Buffer.from(JSON.stringify(jwks)).toString("base64") }] }) + ";\n");
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url"), now = Math.floor(Date.now() / 1000);
const unsigned = b64({ typ: "JWT", alg: "RS256", kid: "n" }) + "." + b64({ iss: issuer, aud: audience, sub: "n-owner", iat: now, exp: now + 3600, name: "Shakur Demo", email: "owner@example.com" });
const token = unsigned + "." + sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
writeFileSync(join(scratch, "src/lib/identity.tsx"), `import type { ReactNode } from "react";
import { ConvexProviderWithAuth, type ConvexReactClient } from "convex/react";
const auth = { isLoading: false, isAuthenticated: true, fetchAccessToken: async () => ${JSON.stringify(token)} };
const useAuth = () => auth;
export function IdentityProvider({ client, children }: { client: ConvexReactClient; children: ReactNode }) { return <ConvexProviderWithAuth client={client} useAuth={useAuth}>{children}</ConvexProviderWithAuth>; }
export function useIdentity() { return { isLoading: false, user: { name: "Shakur Demo", email: "owner@example.com", imageUrl: undefined as string | undefined }, signIn() {}, signUp() {}, signOut() {} }; }
`);

const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CONVEX_AGENT_MODE: "anonymous", CI: "1", CONVEX_DISABLE_METRICS: "1" };
let logs = "", vite;
const backend = spawn(process.execPath, [cli, "dev", "--typecheck", "disable", "--tail-logs", "always", "--local-cloud-port", String(cloudPort), "--local-site-port", String(sitePort)], { cwd: scratch, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
backend.stdout.on("data", (b) => { logs += b; }); backend.stderr.on("data", (b) => { logs += b; });
const stop = () => { for (const child of [backend, vite]) if (child?.pid) try { process.kill(-child.pid, "SIGTERM"); } catch {} };
const transcript = [], note = (step, data) => { transcript.push({ step, ...data }); console.log(step, JSON.stringify(data).slice(0, 300)); };
const site = `http://127.0.0.1:${sitePort}`;
try {
  for (const deadline = Date.now() + 180000; !/Convex functions ready/.test(logs);) { if (backend.exitCode !== null || Date.now() > deadline) throw new Error("backend failed:\n" + logs); await new Promise((r) => setTimeout(r, 300)); }
  execFileSync(process.execPath, [cli, "env", "set", "REMOLD_OPEN_SIGNUP", "1"], { cwd: scratch, env, stdio: "ignore" });
  const client = new ConvexHttpClient(`http://127.0.0.1:${cloudPort}`, { logger: false }); client.setAuth(token);
  await client.mutation(anyApi.users.store, { profile: { name: "Shakur Demo", email: "owner@example.com" } });
  const orgId = await client.mutation(anyApi.orgs.create, { name: "Codemyvibe" });
  const objects = await client.query(anyApi.objects.list, { orgId }), company = objects.find((o) => o.key === "company");
  const fields = (await client.query(anyApi.objects.get, { orgId, objectId: company._id })).fields, nameField = fields.find((f) => f.key === "name")._id;
  const atlas = (await client.mutation(anyApi.records.create, { orgId, objectId: company._id, values: { [nameField]: "Atlas Plumbing" } })).recordId;
  const { key } = await client.action(anyApi.agents.create, { orgId, name: "hosted-check" });

  // A real MCP client over Streamable HTTP, exactly as Claude Code or Codex would connect: URL plus a bearer header.
  const remote = new Client({ name: "n-harness", version: "0" });
  await remote.connect(new StreamableHTTPClientTransport(new URL(`${site}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  note("initialize", { serverVersion: remote.getServerVersion(), capabilities: remote.getServerCapabilities(), instructionsStart: remote.getInstructions()?.slice(0, 60) });
  const listed = (await remote.listTools()).tools;
  note("tools/list", { count: listed.length, names: listed.map((t) => t.name) });
  const text = (r) => r.content[0].text, call = async (name, args) => { const r = await remote.callTool({ name, arguments: args }); note(`tools/call ${name}`, { isError: !!r.isError, text: text(r).slice(0, 400) }); return r; };
  await call("remold_me", {});
  await call("remold_list_records", { object: "company" });
  const proposed = await call("remold_propose_change", { action: "update", record: atlas, values: { city: "Boston" }, reason: "moved", idempotencyKey: "n-harness-1" });
  const again = await call("remold_propose_change", { action: "update", record: atlas, values: { city: "Boston" }, reason: "moved", idempotencyKey: "n-harness-1" });
  note("idempotent replay", { same: text(proposed) === text(again) });
  await call("remold_apply_change", { action: "update", record: atlas, values: { city: "Boston" }, reason: "no grant" });
  await call("remold_get_record", { idOrRef: 7 });
  const unknown = await remote.callTool({ name: "remold_nope", arguments: {} }).catch((e) => String(e));
  note("unknown tool", { error: unknown });
  const raw = async (init) => { const r = await fetch(`${site}/mcp`, init); return { status: r.status, body: await r.text() }; };
  note("no key", await raw({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
  note("unknown key", await raw({ method: "POST", headers: { "content-type": "application/json", authorization: `Bearer rm_${"0".repeat(40)}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
  note("GET", await raw({ method: "GET", headers: { authorization: `Bearer ${key}` } }));
  note("bad JSON", await raw({ method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: "{" }));
  await remote.close();

  // The built stdio server against the same backend: same tools, same answers.
  const local = new Client({ name: "n-harness-stdio", version: "0" });
  await local.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "packages/mcp/dist/index.js")], env: { PATH: process.env.PATH, REMOLD_URL: site, REMOLD_KEY: key } }));
  const again2 = new Client({ name: "n-harness", version: "0" });
  await again2.connect(new StreamableHTTPClientTransport(new URL(`${site}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  const [a, b] = [(await local.listTools()).tools, (await again2.listTools()).tools];
  const [ma, mb] = [await local.callTool({ name: "remold_get_record", arguments: { idOrRef: atlas } }), await again2.callTool({ name: "remold_get_record", arguments: { idOrRef: atlas } })];
  note("stdio vs hosted", { toolsEqual: JSON.stringify(a) === JSON.stringify(b), instructionsEqual: local.getInstructions() === again2.getInstructions(), getRecordEqual: JSON.stringify(ma) === JSON.stringify(mb) });
  await local.close(); await again2.close();
  await new Promise((r) => setTimeout(r, 1500));
  const metrics = JSON.parse(execFileSync(process.execPath, [cli, "run", "telemetry:report", JSON.stringify({ minutes: 5, asOfMinute: Math.floor(Date.now() / 60000) })], { cwd: scratch, env, encoding: "utf8" }));
  note("telemetry (route rest, includes /mcp and the stdio server's REST calls)", { observed: metrics.observed });

  // The Settings agent panel after issuing a key.
  const playwright = process.argv[2];
  if (playwright) {
    const { chromium } = await import(playwright);
    vite = spawn(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "--port", String(vitePort), "--strictPort"], { cwd: scratch, env: { ...env, VITE_CONVEX_URL: `http://127.0.0.1:${cloudPort}`, VITE_WORKOS_CLIENT_ID: "n-harness" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let viteLogs = ""; vite.stdout.on("data", (b) => { viteLogs += b; }); vite.stderr.on("data", (b) => { viteLogs += b; });
    for (const deadline = Date.now() + 60000; !/ready in|Local:/.test(viteLogs);) { if (vite.exitCode !== null || Date.now() > deadline) throw new Error("vite failed:\n" + viteLogs); await new Promise((r) => setTimeout(r, 200)); }
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
    const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://localhost:${vitePort}/o/${orgId}/settings`);
    const card = page.locator('[data-slot="card"]', { hasText: "Agents" }).filter({ has: page.getByLabel("Agent name") });
    await card.waitFor({ timeout: 30000 });
    await card.getByLabel("Agent name").fill("claude-mac");
    await card.getByRole("button", { name: "Add agent" }).click();
    await card.getByText("Paste into your agent. Claude Code:").waitFor({ timeout: 30000 });
    const shown = await card.locator("pre").allInnerTexts(); await card.locator("summary").click();
    note("settings panel", { blocks: shown.map((s) => s.replace(/rm_[0-9a-f]{40}/g, "rm_<key>")), pageErrors: errors });
    await card.locator("div", { hasText: /^Key for claude-mac/ }).first().waitFor();
    await card.screenshot({ path: join(out, "settings-agent-connect.png") });
    await browser.close();
  }
  writeFileSync(join(out, "live-transcript.json"), JSON.stringify(transcript.map((row) => JSON.parse(JSON.stringify(row).replaceAll(key, "rm_<key>"))), null, 1));
  console.log("ok");
} finally {
  stop();
  await new Promise((r) => setTimeout(r, 1000));
  rmSync(scratch, { recursive: true, force: true });
}
