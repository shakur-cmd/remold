import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sendEmail } from "./lib/email";

const env = { RESEND_API_KEY: "re_test_key", REMOLD_EMAIL_FROM: "Remold <remold@example.com>", REMOLD_EMAIL_ALLOWLIST: " Owner@Example.com ,ops@example.com" };
let sent: { url: string; init: any }[];
beforeEach(() => {
  Object.assign(process.env, env);
  sent = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => { sent.push({ url, init }); return new Response(JSON.stringify({ id: "email_1" }), { status: 200 }); }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { for (const key of Object.keys(env)) delete process.env[key]; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("sends plain text through Resend to an allowlisted address, matching case-insensitively", async () => {
  expect(await sendEmail({ to: "owner@EXAMPLE.com", subject: "Today", text: "Two tasks" })).toBe("sent");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.url).toBe("https://api.resend.com/emails");
  expect(sent[0]!.init.method).toBe("POST");
  expect(sent[0]!.init.headers.authorization).toBe("Bearer re_test_key");
  expect(JSON.parse(sent[0]!.init.body)).toEqual({ from: "Remold <remold@example.com>", to: ["owner@EXAMPLE.com"], subject: "Today", text: "Two tasks" });
});

it("refuses and logs an address outside the allowlist without sending", async () => {
  for (const to of ["stranger@example.com", "owner@example.com.evil.test", "owner@example.com, stranger@example.com", ""]) expect(await sendEmail({ to, subject: "s", text: "t" }), to).toBe("refused");
  delete process.env.REMOLD_EMAIL_ALLOWLIST;
  expect(await sendEmail({ to: "owner@example.com", subject: "s", text: "t" })).toBe("refused");
  expect(sent).toEqual([]);
  expect(console.warn).toHaveBeenCalled();
});

it("does not send without an API key or sender, and never throws on a failed send", async () => {
  delete process.env.RESEND_API_KEY;
  for (let i = 0; i < 3; i++) expect(await sendEmail({ to: "owner@example.com", subject: "s", text: "t" })).toBe("unconfigured");
  expect(vi.mocked(console.warn).mock.calls.filter(([message]) => /not set/.test(String(message)))).toHaveLength(1);
  process.env.RESEND_API_KEY = env.RESEND_API_KEY; delete process.env.REMOLD_EMAIL_FROM;
  expect(await sendEmail({ to: "owner@example.com", subject: "s", text: "t" })).toBe("unconfigured");
  expect(sent).toEqual([]);
  process.env.REMOLD_EMAIL_FROM = env.REMOLD_EMAIL_FROM;
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 422 })));
  expect(await sendEmail({ to: "owner@example.com", subject: "s", text: "t" })).toBe("failed");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
  expect(await sendEmail({ to: "owner@example.com", subject: "s", text: "t" })).toBe("failed");
});
