// Booking page screenshots and a real-runtime check, against an isolated local Convex
// backend (anonymous `convex dev --local`) and Vite in a scratch copy. Based on Job A's harness.
// Sign-in is replaced by a self-signed JWT; a browser context marked "visitor" has no sign-in.
// RESEND_API_KEY is unset, so no email can send; nothing here calls Stripe or Resend.
// SERVICE checks: open times computed by the real Convex runtime (Intl time zones), a public
// booking, a race for one time, and a Stripe webhook signed with the saved secret.
// Run from the repo root: node evidence/2026-10-03-campaigns/B/ui-harness.mjs <path to playwright-core>
import { spawn, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const root = resolve("."), out = join(root, "evidence/2026-10-03-campaigns/B");
const { chromium } = await import(process.argv[2]);
const scratch = mkdtempSync(join(tmpdir(), "remold-b-ui-")), cli = join(root, "node_modules/convex/bin/main.js");
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
const visitor = localStorage.getItem("as") === "visitor";
const auth = { isLoading: false, isAuthenticated: !visitor, fetchAccessToken: async () => (visitor ? null : ${JSON.stringify(token)}) };
const useAuth = () => auth;
export function IdentityProvider({ client, children }: { client: ConvexReactClient; children: ReactNode }) { return <ConvexProviderWithAuth client={client} useAuth={useAuth}>{children}</ConvexProviderWithAuth>; }
export function useIdentity() { return { isLoading: false, user: { name: "Shakur Demo", email: "owner@example.com", imageUrl: undefined as string | undefined }, signIn() {}, signUp() {}, signOut() {} }; }
`);

const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CONVEX_AGENT_MODE: "anonymous", CI: "1", CONVEX_DISABLE_METRICS: "1" };
let logs = "";
const backend = spawn(process.execPath, [cli, "dev", "--typecheck", "disable", "--tail-logs", "always", "--local-cloud-port", "3690", "--local-site-port", "3691"], { cwd: scratch, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
backend.stdout.on("data", (b) => { logs += b; }); backend.stderr.on("data", (b) => { logs += b; });
let vite;
const stop = () => { for (const child of [backend, vite]) if (child?.pid) try { process.kill(-child.pid, "SIGTERM"); } catch {} };
const checks = [], check = (name, ok, detail) => { checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) }); };
try {
  for (const deadline = Date.now() + 180000; !/Convex functions ready/.test(logs);) { if (backend.exitCode !== null || Date.now() > deadline) throw new Error("backend failed:\n" + logs); await new Promise((r) => setTimeout(r, 300)); }
  const setEnv = (name, value) => execFileSync(process.execPath, [cli, "env", "set", name, value], { cwd: scratch, env, stdio: "ignore" });
  setEnv("REMOLD_OPEN_SIGNUP", "1"); setEnv("REMOLD_BOOKING_DAILY_CAP", "20"); setEnv("REMOLD_APP_URL", "http://localhost:5390");
  const owner = new ConvexHttpClient("http://127.0.0.1:3690", { logger: false }); owner.setAuth(token);
  const visitor = new ConvexHttpClient("http://127.0.0.1:3690", { logger: false });
  await owner.mutation(anyApi.users.store, { profile: { name: "Shakur Demo", email: "owner@example.com" } });
  const orgId = await owner.mutation(anyApi.orgs.create, { name: "Codemyvibe" });
  const objects = await owner.query(anyApi.objects.list, { orgId }), item = async (key) => { const object = objects.find((o) => o.key === key), detail = await owner.query(anyApi.objects.get, { orgId, objectId: object._id }); return { object, f: Object.fromEntries(detail.fields.map((x) => [x.key, x._id])) }; };
  const [person, campaign, pageObject] = await Promise.all(["person", "campaign", "bookingPage"].map(item));
  const create = async (o, values) => (await owner.mutation(anyApi.records.create, { orgId, objectId: o.object._id, values: Object.fromEntries(Object.entries(values).map(([k, x]) => [o.f[k], x])) })).recordId;
  const ava = await create(person, { name: "Ava Stone", email: "ava@example.com" });
  const campaignId = await create(campaign, { name: "Five-minute calls", status: "active", channel: "email", goal: "Book ten $5 calls", people: [ava] });
  const free = await create(pageObject, { name: "Intro call", description: "A short call about your website and what you want it to do for you.", minutes: 30, hours: "mon-fri 09:00-12:00, 13:00-17:00", timezone: "America/New_York", noticeHours: 12, daysAhead: 30, campaign: campaignId, live: true });
  const paid = await create(pageObject, { name: "Five dollar call", description: "Five focused minutes on one question. Paid up front through Stripe.", minutes: 15, hours: "mon-thu 10:00-12:00", timezone: "America/New_York", noticeHours: 2, daysAhead: 14, price: 5, paymentLink: "https://buy.stripe.com/test_harness", campaign: campaignId, live: true });

  // Real runtime: every open time is inside the hours in New York, and the first is after the notice.
  const shown = await visitor.query(anyApi.bookings.page, { pageId: free });
  const ny = (ms) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
  check("public page keys", JSON.stringify(Object.keys(shown).sort()) === JSON.stringify(["description", "minutes", "name", "open", "paid", "price", "slots"]), Object.keys(shown));
  check("open times inside hours in America/New_York (real Convex runtime Intl)", shown.slots.length > 100 && shown.slots.every((s) => /^(Mon|Tue|Wed|Thu|Fri) (09|10|11|13|14|15|16):(00|30)$/.test(ny(s))), { count: shown.slots.length, first: ny(shown.slots[0]), last: ny(shown.slots.at(-1)) });
  check("first open time after 12 hours notice", shown.slots[0] >= Date.now() + 12 * 3600000);
  const race = shown.slots[3];
  const results = await Promise.all(["ben", "cy", "dee"].map((n) => visitor.mutation(anyApi.bookings.book, { pageId: free, start: race, name: n[0].toUpperCase() + n.slice(1) + " Visitor", email: `${n}@example.com`, zone: "America/Chicago" })));
  check("three visitors race for one time: one confirmed", results.map((r) => r.status).sort().join() === "confirmed,taken,taken", results.map((r) => r.status));
  await visitor.mutation(anyApi.bookings.book, { pageId: free, start: shown.slots[20], name: "Eve Lund", email: "eve@example.com", note: "Interested in a redesign." });
  const paidSlots = (await visitor.query(anyApi.bookings.page, { pageId: paid })).slots;
  const held = await visitor.mutation(anyApi.bookings.book, { pageId: paid, start: paidSlots[2], name: "Ava Stone", email: "ava@example.com", zone: "America/New_York" });
  check("paid page holds and redirects to the Payment Link", held.status === "held" && held.pay.startsWith("https://buy.stripe.com/test_harness?client_reference_id="), held);
  const ref = new URL(held.pay).searchParams.get("client_reference_id");
  await visitor.mutation(anyApi.bookings.book, { pageId: paid, start: paidSlots[5], name: "Finn Hale", email: "finn@example.com" });

  // Stripe webhook on the real HTTP router.
  const secret = "whsec_" + Buffer.from("ui-harness-stripe").toString("base64");
  const hook = async (body, key = secret, ts = Math.floor(Date.now() / 1000)) => (await fetch(`http://127.0.0.1:3691/webhooks/stripe/${orgId}`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=${createHmac("sha256", key).update(`${ts}.${body}`).digest("hex")}` }, body })).status;
  const event = JSON.stringify({ id: "evt_harness_1", type: "checkout.session.completed", data: { object: { id: "cs_test_harness", client_reference_id: ref, payment_status: "paid", amount_total: 500, currency: "usd" } } });
  check("webhook before a secret is saved: 503", (await hook(event)) === 503);
  await owner.mutation(anyApi.bookings.savePaymentSecret, { orgId, secret });
  check("webhook with a wrong key: 400", (await hook(event, "whsec_wrong_key_123")) === 400);
  check("webhook with a stale time: 400", (await hook(event, secret, Math.floor(Date.now() / 1000) - 400)) === 400);
  check("signed paid event: 200", (await hook(event)) === 200);
  check("same event again: 200", (await hook(event)) === 200);
  const listed = await owner.query(anyApi.bookings.forPage, { orgId, pageId: paid });
  check("paid booking confirmed with the event's amount", listed.some((b) => b.name === "Ava Stone" && b.status === "confirmed" && b.paid === "$5.00"), listed);
  const report = await owner.query(anyApi.campaigns.report, { orgId, campaignId });
  check("campaign report counts bookings and revenue", report.bookings.booked === 3 && report.bookings.paid === 1 && report.bookings.revenue[0]?.amountMinor === 500, report.bookings);

  vite = spawn(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "--port", "5390", "--strictPort"], { cwd: scratch, env: { ...env, VITE_CONVEX_URL: "http://127.0.0.1:3690", VITE_WORKOS_CLIENT_ID: "ui-harness" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let viteLogs = ""; vite.stdout.on("data", (b) => { viteLogs += b; }); vite.stderr.on("data", (b) => { viteLogs += b; });
  for (const deadline = Date.now() + 60000; !/ready in|Local:/.test(viteLogs);) { if (vite.exitCode !== null || Date.now() > deadline) throw new Error("vite failed:\n" + viteLogs); await new Promise((r) => setTimeout(r, 200)); }

  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const open = async (viewport, as, timezoneId = "America/Chicago") => {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2, timezoneId, locale: "en-US" });
    if (as === "visitor") await context.addInitScript(() => localStorage.setItem("as", "visitor"));
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(String(e))); page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    return page;
  };
  const desk = await open({ width: 1280, height: 860 }, "visitor");
  await desk.goto(`http://localhost:5390/book/${free}`);
  await desk.getByRole("heading", { name: "Intro call" }).waitFor({ timeout: 30000 });
  check("visitor sees no owner notice", !(await desk.getByText("Only your team sees this").count()));
  await desk.screenshot({ path: join(out, "booking-page-desktop.png") });
  await desk.getByRole("option").nth(1).click();
  await desk.getByRole("button", { name: /AM|PM/ }).first().click();
  await desk.getByLabel("Name").fill("Gia Ross"); await desk.getByLabel("Email").fill("gia@example.com");
  await desk.screenshot({ path: join(out, "booking-page-form.png") });
  await desk.getByRole("button", { name: "Book this time" }).click();
  await desk.getByRole("heading", { name: "You are booked" }).waitFor({ timeout: 30000 });
  await desk.screenshot({ path: join(out, "booking-page-booked.png") });
  const phone = await open({ width: 390, height: 844 }, "visitor", "America/Los_Angeles");
  await phone.goto(`http://localhost:5390/book/${paid}`);
  await phone.getByRole("heading", { name: "Five dollar call" }).waitFor({ timeout: 30000 });
  await phone.screenshot({ path: join(out, "booking-page-phone.png"), fullPage: true });
  await owner.mutation(anyApi.records.update, { orgId, recordId: paid, values: { [pageObject.f.live]: false } });
  await phone.getByText("This page is not taking bookings.").waitFor({ timeout: 30000 });
  await phone.screenshot({ path: join(out, "booking-page-closed-phone.png") });
  await owner.mutation(anyApi.records.update, { orgId, recordId: paid, values: { [pageObject.f.live]: true } });

  const app = await open({ width: 1280, height: 900 }, "owner");
  await app.goto(`http://localhost:5390/o/${orgId}/settings`);
  const card = app.locator('[data-slot="card"]', { hasText: "Payments" });
  await card.getByText("Signing secret saved.").waitFor({ timeout: 30000 });
  check("Payments card never shows the secret", !(await card.innerText()).includes(secret));
  await card.screenshot({ path: join(out, "settings-payments-card.png") });
  await app.goto(`http://localhost:5390/o/${orgId}/bookingPage/${paid}`);
  await app.getByRole("heading", { name: "Bookings" }).waitFor({ timeout: 30000 });
  await app.getByText("Finn Hale").waitFor({ timeout: 30000 });
  await app.screenshot({ path: join(out, "booking-page-record.png"), fullPage: true });
  await app.goto(`http://localhost:5390/book/${free}`);
  await app.getByText("Only your team sees this").waitFor({ timeout: 30000 });
  await app.screenshot({ path: join(out, "booking-page-owner-notice.png") });
  await app.goto(`http://localhost:5390/o/${orgId}/campaign/${campaignId}`);
  await app.getByText("Revenue").waitFor({ timeout: 30000 });
  await app.screenshot({ path: join(out, "campaign-funnel-bookings.png"), fullPage: true });
  await browser.close();
  console.log(JSON.stringify({ ok: checks.every((c) => c.ok), orgId, checks, pageErrors: errors }, null, 1));
} finally {
  stop();
  await new Promise((r) => setTimeout(r, 1000));
  rmSync(scratch, { recursive: true, force: true });
}
