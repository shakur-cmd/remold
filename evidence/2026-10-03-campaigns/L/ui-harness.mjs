// Screenshots of Today (Mine, Waiting on others), the Settings time zone and a task's assignee, against an
// isolated local Convex backend (anonymous `convex dev --local`) and Vite in a scratch copy.
// Sign-in is replaced by a self-signed JWT. RESEND_API_KEY stays unset, so nothing can send.
// Run from the repo root: node evidence/2026-10-03-campaigns/L/ui-harness.mjs <path to playwright-core>
import { spawn, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const root = resolve("."), out = join(root, "evidence/2026-10-03-campaigns/L");
const playwright = await import(process.argv[2]), chromium = playwright.chromium ?? playwright.default.chromium;
const scratch = mkdtempSync(join(tmpdir(), "remold-l-ui-")), cli = join(root, "node_modules/convex/bin/main.js");
for (const path of ["convex", "src", "public", "packages/contracts", "index.html", "vite.config.ts", "tsconfig.json", "tsconfig.app.json", "tsconfig.node.json", "components.json", "package.json"]) cpSync(join(root, path), join(scratch, path), { recursive: true, filter: (p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx") });
symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"), "dir");

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "ui", alg: "RS256", use: "sig" }] }, issuer = "https://ui-harness.invalid", audience = "ui-remold";
writeFileSync(join(scratch, "convex/auth.config.ts"), "export default " + JSON.stringify({ providers: [{ type: "customJwt", issuer, applicationID: audience, algorithm: "RS256", jwks: "data:text/plain;charset=utf-8;base64," + Buffer.from(JSON.stringify(jwks)).toString("base64") }] }) + ";\n");
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url"), now = Math.floor(Date.now() / 1000);
const unsigned = b64({ typ: "JWT", alg: "RS256", kid: "ui" }) + "." + b64({ iss: issuer, aud: audience, sub: "ui-owner", iat: now, exp: now + 3600, name: "Shakur Demo", email: "owner@example.com" });
const token = unsigned + "." + sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
writeFileSync(join(scratch, "src/lib/identity.tsx"), `import type { ReactNode } from "react";
import { ConvexProviderWithAuth, type ConvexReactClient } from "convex/react";
const auth = { isLoading: false, isAuthenticated: true, fetchAccessToken: async () => ${JSON.stringify(token)} };
const useAuth = () => auth;
export function IdentityProvider({ client, children }: { client: ConvexReactClient; children: ReactNode }) { return <ConvexProviderWithAuth client={client} useAuth={useAuth}>{children}</ConvexProviderWithAuth>; }
export function useIdentity() { return { isLoading: false, user: { name: "Shakur Demo", email: "owner@example.com", imageUrl: undefined as string | undefined }, signIn() {}, signUp() {}, signOut() {} }; }
`);

const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CONVEX_AGENT_MODE: "anonymous", CI: "1", CONVEX_DISABLE_METRICS: "1" };
let logs = "";
const backend = spawn(process.execPath, [cli, "dev", "--typecheck", "disable", "--tail-logs", "always", "--local-cloud-port", "3590", "--local-site-port", "3591"], { cwd: scratch, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
backend.stdout.on("data", (b) => { logs += b; }); backend.stderr.on("data", (b) => { logs += b; });
let vite;
const stop = () => { for (const child of [backend, vite]) if (child?.pid) try { process.kill(-child.pid, "SIGTERM"); } catch {} };
try {
  for (const deadline = Date.now() + 180000; !/Convex functions ready/.test(logs);) { if (backend.exitCode !== null || Date.now() > deadline) throw new Error("backend failed:\n" + logs); await new Promise((r) => setTimeout(r, 300)); }
  execFileSync(process.execPath, [cli, "env", "set", "REMOLD_OPEN_SIGNUP", "1"], { cwd: scratch, env, stdio: "ignore" });
  const client = new ConvexHttpClient("http://127.0.0.1:3590", { logger: false }); client.setAuth(token);
  await client.mutation(anyApi.users.store, { profile: { name: "Shakur Demo", email: "owner@example.com" } });
  const orgId = await client.mutation(anyApi.orgs.create, { name: "Codemyvibe" });
  await client.mutation(anyApi.orgs.setTimeZone, { orgId, timeZone: "America/New_York" });
  const me = (await client.query(anyApi.orgs.members, { orgId }))[0].user._id;
  const scout = await client.action(anyApi.agents.create, { orgId, name: "Scout" });
  const objects = await client.query(anyApi.objects.list, { orgId }), taskObject = objects.find((o) => o.key === "task"), detail = await client.query(anyApi.objects.get, { orgId, objectId: taskObject._id });
  const f = Object.fromEntries(detail.fields.map((x) => [x.key, x._id]));
  const DAY = 86400000, now = Date.now(), local = new Date(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now) + "T00:00:00Z").getTime();
  const task = async (values) => (await client.mutation(anyApi.records.create, { orgId, objectId: taskObject._id, values: Object.fromEntries(Object.entries(values).map(([k, x]) => [f[k], x])) })).recordId;
  await task({ title: "Send the launch email", assignee: me, dueDate: local - DAY });
  await task({ title: "Call Atlas Plumbing", assignee: me, dueDate: local });
  await task({ title: "Write the case study", assignee: me });
  const logo = await task({ title: "Get the logo from the designer", assignee: scout.agentId, dueDate: local + DAY });
  await task({ title: "Publish the launch post", assignee: me, blockedBy: [logo] });
  await task({ title: "Order business cards", dueDate: local });

  vite = spawn(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "--port", "5291", "--strictPort"], { cwd: scratch, env: { ...env, VITE_CONVEX_URL: "http://127.0.0.1:3590", VITE_WORKOS_CLIENT_ID: "ui-harness" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let viteLogs = ""; vite.stdout.on("data", (b) => { viteLogs += b; }); vite.stderr.on("data", (b) => { viteLogs += b; });
  for (const deadline = Date.now() + 60000; !/ready in|Local:/.test(viteLogs);) { if (vite.exitCode !== null || Date.now() > deadline) throw new Error("vite failed:\n" + viteLogs); await new Promise((r) => setTimeout(r, 200)); }

  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e))); page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`http://localhost:5291/o/${orgId}/today`);
  try { await page.getByText("Waiting on others").waitFor({ timeout: 30000 }); } catch (error) { console.log("DEBUG", page.url(), (await page.locator("body").innerText()).slice(0, 500), errors); throw error; }
  await page.screenshot({ path: join(out, "today-mine.png"), fullPage: true });
  await page.goto(`http://localhost:5291/o/${orgId}/settings`);
  const zone = page.locator("#time-zone"); await zone.waitFor({ timeout: 30000 });
  await page.locator('[data-slot="card"]', { hasText: "Organisation" }).first().screenshot({ path: join(out, "settings-time-zone.png") });
  await page.goto(`http://localhost:5291/o/${orgId}/task`);
  await page.getByText("Publish the launch post").first().click();
  await page.getByText("Assignee").first().waitFor({ timeout: 30000 });
  await page.getByText("Shakur Demo").first().waitFor({ timeout: 30000 });
  await page.screenshot({ path: join(out, "task-assignee.png"), fullPage: true });
  await browser.close();
  console.log(JSON.stringify({ ok: true, orgId, pageErrors: errors, shots: ["today-mine.png", "settings-time-zone.png", "task-assignee.png"] }));
} finally {
  stop();
  await new Promise((r) => setTimeout(r, 1000));
  rmSync(scratch, { recursive: true, force: true });
}
