// Screenshots of the Settings email card and a campaign's Emails section, against an
// isolated local Convex backend (anonymous `convex dev --local`) and Vite in a scratch copy.
// Sign-in is replaced by a self-signed JWT; send rows on the first email are a SIM fixture.
// RESEND_API_KEY and REMOLD_CAMPAIGN_DAILY_CAP stay unset, so the cron can never send.
// Run from the repo root: node evidence/2026-10-03-campaigns/A/ui-harness.mjs <path to playwright-core>
import { spawn, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const root = resolve("."), out = join(root, "evidence/2026-10-03-campaigns/A");
const { chromium } = await import(process.argv[2]);
const scratch = mkdtempSync(join(tmpdir(), "remold-a-ui-")), cli = join(root, "node_modules/convex/bin/main.js");
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
// SIM: send rows with outcomes, as the webhook would have left them.
writeFileSync(join(scratch, "convex/uiFixture.ts"), `import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
export const sends = internalMutation({ args: { orgId: v.id("orgs"), emailId: v.id("records"), campaignId: v.id("records"), statusFieldId: v.string(), rows: v.array(v.object({ personId: v.id("records"), to: v.string(), subject: v.string(), opened: v.boolean(), clicked: v.boolean(), replied: v.boolean(), skip: v.optional(v.string()) })) }, handler: async (ctx, a) => {
  const at = Date.now() - 86400000;
  for (const [i, r] of a.rows.entries()) await ctx.db.insert("emailSends", { orgId: a.orgId, emailRecordId: a.emailId, campaignRecordId: a.campaignId, personRecordId: r.personId, to: r.to, subject: r.subject, token: "f".repeat(31) + i, attempts: r.skip ? 0 : 1, ...(r.skip ? { status: "skipped" as const, skipReason: r.skip } : { status: "sent" as const, providerId: "sim_" + i, sentAt: at, deliveredAt: at, ...(r.opened ? { openedAt: at + 3600000, opens: 1 } : {}), ...(r.clicked ? { clickedAt: at + 3700000, clicks: 1 } : {}), ...(r.replied ? { repliedAt: at + 7200000 } : {}) }) });
  const email = (await ctx.db.get(a.emailId))!;
  await ctx.db.patch(a.emailId, { values: { ...email.values, [a.statusFieldId]: "sent" } });
  const run = await ctx.db.query("emailRuns").withIndex("by_email", (q) => q.eq("emailRecordId", a.emailId)).unique();
  if (run) await ctx.db.patch(run._id, { live: false });
} });
`);

const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CONVEX_AGENT_MODE: "anonymous", CI: "1", CONVEX_DISABLE_METRICS: "1" };
let logs = "";
const backend = spawn(process.execPath, [cli, "dev", "--typecheck", "disable", "--tail-logs", "always", "--local-cloud-port", "3590", "--local-site-port", "3591"], { cwd: scratch, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
backend.stdout.on("data", (b) => { logs += b; }); backend.stderr.on("data", (b) => { logs += b; });
let vite;
const stop = () => { for (const child of [backend, vite]) if (child?.pid) try { process.kill(-child.pid, "SIGTERM"); } catch {} };
try {
  for (const deadline = Date.now() + 180000; !/Convex functions ready/.test(logs);) { if (backend.exitCode !== null || Date.now() > deadline) throw new Error("backend failed:\n" + logs); await new Promise((r) => setTimeout(r, 300)); }
  const setEnv = (name, value) => execFileSync(process.execPath, [cli, "env", "set", name, value], { cwd: scratch, env, stdio: "ignore" });
  setEnv("REMOLD_OPEN_SIGNUP", "1"); setEnv("REMOLD_SENDER_DOMAINS", "mail.example.com"); setEnv("RESEND_WEBHOOK_SECRET", "whsec_" + Buffer.from("ui-harness-only").toString("base64"));
  const run = (fn, args) => JSON.parse(execFileSync(process.execPath, [cli, "run", fn, JSON.stringify(args)], { cwd: scratch, env, encoding: "utf8" }).trim() || "null");
  const client = new ConvexHttpClient("http://127.0.0.1:3590", { logger: false }); client.setAuth(token);
  await client.mutation(anyApi.users.store, { profile: { name: "Shakur Demo", email: "owner@example.com" } });
  const orgId = await client.mutation(anyApi.orgs.create, { name: "Codemyvibe" });
  await client.mutation(anyApi.campaigns.saveSettings, { orgId, fromName: "Shakur at Codemyvibe", fromAddress: "shakur@mail.example.com", postalAddress: "100 Example Street, Springfield, MD 20000", dailyLimit: 50 });
  const objects = await client.query(anyApi.objects.list, { orgId }), item = async (key) => { const object = objects.find((o) => o.key === key), detail = await client.query(anyApi.objects.get, { orgId, objectId: object._id }); return { object, f: Object.fromEntries(detail.fields.map((x) => [x.key, x._id])) }; };
  const [person, company, campaign, email] = await Promise.all(["person", "company", "campaign", "email"].map(item));
  const create = async (o, values) => (await client.mutation(anyApi.records.create, { orgId, objectId: o.object._id, values: Object.fromEntries(Object.entries(values).map(([k, x]) => [o.f[k], x])) })).recordId;
  const names = ["Ava Stone", "Ben Ortiz", "Cy Diaz", "Dee Park", "Eve Lund", "Finn Hale", "Gia Ross", "Hal Moore"], people = [];
  for (const name of names) people.push({ name, id: await create(person, { name, email: name.split(" ")[0].toLowerCase() + "@example.com", company: await create(company, { name: name.split(" ")[1] + " Plumbing" }) }) });
  const campaignId = await create(campaign, { name: "Five-minute calls", status: "active", channel: "email", goal: "Book ten $5 calls", people: people.map((p) => p.id) });
  const first = await create(email, { subject: "Quick call, {{firstName|there}}?", body: "Hi {{firstName|there}},\n\nI help small businesses like {{company}} get more from their CRM. Want a five-minute call for $5?\n\nBook here: https://example.com/book\n\nShakur", campaign: campaignId, status: "draft" });
  await client.mutation(anyApi.campaigns.approve, { orgId, emailId: first, confirmed: true });
  const outcome = [[1, 1, 1], [1, 1, 0], [1, 0, 0], [1, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  run("uiFixture:sends", { orgId, emailId: first, campaignId, statusFieldId: email.f.status, rows: people.map((p, i) => i === 7 ? { personId: p.id, to: "hal@example.com", subject: "Quick call, Hal?", opened: false, clicked: false, replied: false, skip: "unsubscribed" } : { personId: p.id, to: p.name.split(" ")[0].toLowerCase() + "@example.com", subject: `Quick call, ${p.name.split(" ")[0]}?`, opened: !!outcome[i][0], clicked: !!outcome[i][1], replied: !!outcome[i][2] }) });
  await create(email, { subject: "Still up for a quick call?", body: "Hi {{firstName|there}},\n\nJust checking you saw this. Five minutes, $5: https://example.com/book\n\nShakur", campaign: campaignId, followsUp: first, waitDays: 1, sendTo: "notReplied", status: "draft" });

  vite = spawn(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "--port", "5290", "--strictPort"], { cwd: scratch, env: { ...env, VITE_CONVEX_URL: "http://127.0.0.1:3590", VITE_WORKOS_CLIENT_ID: "ui-harness" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let viteLogs = ""; vite.stdout.on("data", (b) => { viteLogs += b; }); vite.stderr.on("data", (b) => { viteLogs += b; });
  for (const deadline = Date.now() + 60000; !/ready in|Local:/.test(viteLogs);) { if (vite.exitCode !== null || Date.now() > deadline) throw new Error("vite failed:\n" + viteLogs); await new Promise((r) => setTimeout(r, 200)); }

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e))); page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`http://localhost:5290/o/${orgId}/settings`);
  const card = page.locator('[data-slot="card"]', { hasText: "Email sending" });
  try { await card.waitFor({ timeout: 30000 }); } catch (error) { await page.screenshot({ path: join(scratch, "..", "remold-a-debug.png") }); console.log("DEBUG", page.url(), (await page.locator("body").innerText()).slice(0, 500), errors); throw error; }
  await card.screenshot({ path: join(out, "settings-email-card.png") });
  await page.goto(`http://localhost:5290/o/${orgId}/campaign/${campaignId}`);
  const section = page.locator("section", { has: page.getByRole("heading", { name: "Emails" }) });
  await section.getByText("Still up for a quick call?").waitFor({ timeout: 30000 });
  await section.getByRole("button", { name: "People" }).click();
  await section.getByText("Mark replied").first().waitFor();
  await section.screenshot({ path: join(out, "campaign-emails.png") });
  await page.screenshot({ path: join(out, "campaign-page.png"), fullPage: true });
  await section.getByRole("button", { name: "Approve" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText(/^As .* sees it$/).waitFor({ timeout: 30000 });
  await dialog.screenshot({ path: join(out, "approve-dialog.png") });
  await browser.close();
  console.log(JSON.stringify({ ok: true, orgId, campaignId, pageErrors: errors, shots: ["settings-email-card.png", "campaign-emails.png", "campaign-page.png", "approve-dialog.png"] }));
} finally {
  stop();
  await new Promise((r) => setTimeout(r, 1000));
  rmSync(scratch, { recursive: true, force: true });
}
