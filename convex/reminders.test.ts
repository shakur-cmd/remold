import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { api, objectFields } from "./test.helpers";
import { makeTest } from "./test.setup";
import crons from "./crons";

const send = makeFunctionReference<"action">("reminders:send");
const DAY = 86_400_000, today = Date.UTC(2026, 9, 1), at11 = today + 11 * 3_600_000;
const env = { RESEND_API_KEY: "re_test_key", REMOLD_EMAIL_FROM: "Remold <remold@example.com>", REMOLD_EMAIL_ALLOWLIST: "a@example.com,b@example.com", REMOLD_APP_URL: "https://app.example.com" };
let mails: { to: string[]; subject: string; text: string }[];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(at11); Object.assign(process.env, env); mails = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => { mails.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); for (const key of Object.keys(env)) delete process.env[key]; });

async function workspace(t: any, name: string, email: string) {
  const client = t.withIdentity({ tokenIdentifier: `clerk|${name}`, name, email });
  await client.mutation(api.users.store, {});
  const orgId = await client.mutation(api.orgs.create, { name: `${name} Org` });
  const task = await objectFields(client, orgId, "task");
  const add = async (title: string, due?: number) => (await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: title, ...(due === undefined ? {} : { [task.fields.dueDate._id]: due }) } })).recordId;
  const done = (recordId: any) => client.mutation(api.records.update, { orgId, recordId, values: { [task.fields.done._id]: true } });
  return { client, orgId, add, done };
}
const mailTo = (to: string) => mails.filter((m) => m.to.includes(to));

it("runs the reminder once a day at 11:00 UTC", () => {
  expect(Object.values((crons as any).crons)).toContainEqual(expect.objectContaining({ name: "reminders:send", schedule: { type: "cron", cron: "0 11 * * *" } }));
});

it("emails each opted-in owner their own due, overdue and quiet work with a link to Today", async () => {
  const t = makeTest(), a = await workspace(t, "A", "a@example.com"), b = await workspace(t, "B", "b@example.com");
  await a.add("Call the bank", today); await a.add("Send the invoice", today - 3 * DAY); await a.add("Plan next month", today + 5 * DAY); await a.add("Someday");
  await b.add("B private task", today);
  expect(await a.client.query(api.reminders.mine, { orgId: a.orgId })).toEqual({ on: false, email: "a@example.com" });
  await t.action(send, {});
  expect(mails).toEqual([]);
  await a.client.mutation(api.reminders.set, { orgId: a.orgId, on: true });
  await b.client.mutation(api.reminders.set, { orgId: b.orgId, on: true });
  await t.action(send, {});
  const [mail] = mailTo("a@example.com");
  expect(mailTo("a@example.com")).toHaveLength(1);
  expect(mail!.text).toContain("Call the bank");
  expect(mail!.text).toContain("Send the invoice");
  expect(mail!.text.indexOf("Send the invoice")).toBeLessThan(mail!.text.indexOf("Call the bank"));
  expect(mail!.text).not.toContain("Plan next month");
  expect(mail!.text).not.toContain("Someday");
  expect(mail!.text).not.toContain("B private task");
  expect(mail!.text).toContain(`https://app.example.com/o/${a.orgId}/today`);
  expect(mailTo("b@example.com")[0]!.text).toContain("B private task");
  expect(mailTo("b@example.com")[0]!.text).not.toContain("Call the bank");
});

it("includes records gone quiet", async () => {
  const t = makeTest(), a = await workspace(t, "A", "a@example.com");
  const opp = await objectFields(a.client, a.orgId, "opportunity");
  vi.setSystemTime(at11 - 20 * DAY);
  await a.client.mutation(api.records.create, { orgId: a.orgId, objectId: opp.object._id, values: { [opp.fields.name._id]: "Sleepy deal", [opp.fields.stage._id]: "qualified" } });
  await a.client.mutation(api.records.create, { orgId: a.orgId, objectId: opp.object._id, values: { [opp.fields.name._id]: "Closed deal", [opp.fields.stage._id]: "won" } });
  vi.setSystemTime(at11);
  await a.client.mutation(api.reminders.set, { orgId: a.orgId, on: true });
  await t.action(send, {});
  expect(mails[0]!.text).toContain("Sleepy deal");
  expect(mails[0]!.text).not.toContain("Closed deal");
});

it("drops a task marked done from the next email, and works whether due carries a time of day", async () => {
  const t = makeTest(), a = await workspace(t, "A", "a@example.com");
  const first = await a.add("Morning call", today + 9 * 3_600_000), second = await a.add("Afternoon call", today + 14 * 3_600_000 + 32 * 60_000);
  await a.client.mutation(api.reminders.set, { orgId: a.orgId, on: true });
  await t.action(send, {});
  expect(mails[0]!.text).toContain("Morning call");
  expect(mails[0]!.text).toContain("Afternoon call");
  expect(mails[0]!.text).toContain("14:32");
  await a.done(first);
  vi.setSystemTime(at11 + DAY);
  await t.action(send, {});
  expect(mails[1]!.text).not.toContain("Morning call");
  expect(mails[1]!.text).toContain("Afternoon call");
  // Nothing left: no email at all.
  await a.done(second);
  vi.setSystemTime(at11 + 2 * DAY);
  await t.action(send, {});
  expect(mails).toHaveLength(2);
});

it("does not email an address outside the allowlist, and turning reminders off stops them", async () => {
  const t = makeTest(), a = await workspace(t, "A", "a@example.com"), c = await workspace(t, "C", "c@example.com");
  await a.add("Mine", today); await c.add("Theirs", today);
  await a.client.mutation(api.reminders.set, { orgId: a.orgId, on: true });
  await c.client.mutation(api.reminders.set, { orgId: c.orgId, on: true });
  await t.action(send, {});
  expect(mails.map((m) => m.to)).toEqual([["a@example.com"]]);
  await a.client.mutation(api.reminders.set, { orgId: a.orgId, on: false });
  vi.setSystemTime(at11 + DAY);
  await t.action(send, {});
  expect(mails).toHaveLength(1);
});

it("a member can always turn their own reminder off, but a read-only workspace refuses turning it on", async () => {
  const t = makeTest(), a = await workspace(t, "A", "a@example.com");
  await a.add("Mine", today);
  await a.client.mutation(api.reminders.set, { orgId: a.orgId, on: true });
  expect(await a.client.query(api.reminders.mine, { orgId: a.orgId })).toEqual({ on: true, email: "a@example.com" });
  await t.run((ctx: any) => ctx.db.patch(a.orgId, { flags: { readonly: true } }));
  await a.client.mutation(api.reminders.set, { orgId: a.orgId, on: false });
  expect(await a.client.query(api.reminders.mine, { orgId: a.orgId })).toEqual({ on: false, email: "a@example.com" });
  await t.action(send, {});
  expect(mails).toEqual([]);
  await expect(a.client.mutation(api.reminders.set, { orgId: a.orgId, on: true })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  const stranger = t.withIdentity({ tokenIdentifier: "clerk|S", name: "S", email: "b@example.com" });
  await stranger.mutation(api.users.store, {});
  await expect(stranger.query(api.reminders.mine, { orgId: a.orgId })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  await expect(stranger.mutation(api.reminders.set, { orgId: a.orgId, on: false })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
});

it("a second reminder run on the same UTC day sends nothing, and the next day sends again", async () => {
  const t = makeTest(), a = await workspace(t, "A", "a@example.com");
  await a.add("Mine", today);
  await a.client.mutation(api.reminders.set, { orgId: a.orgId, on: true });
  await t.action(send, {});
  vi.setSystemTime(at11 + 12 * 3_600_000);
  await Promise.all([t.action(send, {}), t.action(send, {})]);
  expect(mails).toHaveLength(1);
  vi.setSystemTime(at11 + DAY);
  await t.action(send, {});
  expect(mails).toHaveLength(2);
  expect(mails[1]!.text).toContain("Overdue");
});

it("a failed send is retried by a later run the same day, then sends nothing more", async () => {
  const t = makeTest(), a = await workspace(t, "A", "a@example.com");
  await a.add("Mine", today);
  await a.client.mutation(api.reminders.set, { orgId: a.orgId, on: true });
  let up = false, attempts = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => { attempts++; if (up) mails.push(JSON.parse(init.body)); return new Response("{}", { status: up ? 200 : 503 }); }));
  await t.action(send, {});
  expect([attempts, mails.length]).toEqual([1, 0]);
  up = true;
  await t.action(send, {});
  await t.action(send, {});
  expect([attempts, mails.length]).toEqual([2, 1]);
});

it("reads 'today' in the workspace's time zone, and sends once per local day", async () => {
  const t = makeTest(), a = await workspace(t, "A", "a@example.com");
  await a.client.mutation(api.orgs.setTimeZone, { orgId: a.orgId, timeZone: "America/New_York" });
  await a.client.mutation(api.reminders.set, { orgId: a.orgId, on: true });
  // 02:00 UTC on Oct 1 is 22:00 on Sept 30 in New York.
  vi.setSystemTime(Date.UTC(2026, 9, 1, 2));
  await a.add("Due in New York today", Date.UTC(2026, 8, 30));
  await a.add("Due late tonight", Date.UTC(2026, 9, 1, 3, 30));
  await a.add("Due tomorrow in New York", Date.UTC(2026, 9, 1));
  await t.action(send, {});
  const [mail] = mailTo("a@example.com");
  expect(mail!.text).toContain("Your Remold list for 2026-09-30");
  expect(mail!.text).toMatch(/Due today\n- Due in New York today \(due 2026-09-30\)[\s\S]*- Due late tonight \(due 2026-09-30 23:30 America\/New_York\)/);
  expect(mail!.text).not.toContain("Overdue");
  expect(mail!.text).not.toContain("Due tomorrow in New York");
  vi.setSystemTime(Date.UTC(2026, 9, 1, 3, 45));
  await t.action(send, {});
  expect(mailTo("a@example.com")).toHaveLength(1);
  // Past local midnight it is a new day, so the next run mails again.
  vi.setSystemTime(Date.UTC(2026, 9, 1, 11));
  await t.action(send, {});
  expect(mailTo("a@example.com")).toHaveLength(2);
  expect(mailTo("a@example.com")[1]!.text).toContain("Your Remold list for 2026-10-01");
});
