declare const process: { env: Record<string, string | undefined> };

// Pure pieces of campaign email: merge tags, the message as sent, configuration
// checks and webhook signatures. Nothing here reads the database.

export const DAY = 86_400_000;
export const normalAddress = (value: string) => value.trim().toLowerCase();
export const validAddress = (value: string) => value.length <= 254 && /^[^\s@,;<>"()]+@[^\s@,;<>"()]+\.[^\s@,;<>"()]+$/.test(value);
// "Ava <ava@x.com>" or a bare address, lowercased; null when there is none.
export const addressIn = (value: string) => { const found = /<([^>]+)>/.exec(value)?.[1] ?? value; const address = normalAddress(found); return validAddress(address) ? address : null; };

// A recipient as merge tags see them. Other features add tags to `mergeTags`;
// Job B's {{bookingLink}} reads `token`, so a booking can be traced to its send.
export type Recipient = { name: string; company?: string; token?: string };
export const mergeTags: Record<string, (recipient: Recipient) => string | undefined> = {
  firstName: (r) => r.name.trim().split(/\s+/)[0],
  name: (r) => r.name.trim(),
  company: (r) => r.company?.trim(),
};
const TAG = /\{\{([^{}]*)\}\}/g, INNER = /^\s*([A-Za-z]+)\s*(?:\|([^|]*))?$/;

// Every {{...}} that is not a known tag, plus any {{ left unclosed.
export function badTags(text: string) {
  const bad = [...text.matchAll(TAG)].filter(([, inner]) => { const name = INNER.exec(inner!)?.[1]; return !name || !Object.hasOwn(mergeTags, name); }).map(([whole]) => whole);
  return /\{\{(?![^{}]*\}\})/.test(text) ? [...bad, "{{"] : bad;
}
// An empty value uses the fallback written after "|", else nothing.
export const render = (text: string, recipient: Recipient) => text.replace(TAG, (whole, inner: string) => {
  const [, name, fallback] = INNER.exec(inner) ?? [];
  return name && Object.hasOwn(mergeTags, name) ? mergeTags[name]!(recipient) || fallback?.trim() || "" : whole;
});

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Escaped text with links and line breaks, nothing more.
export const toHtml = (text: string) => `<div style="font-family:sans-serif;font-size:15px;line-height:1.5">${escape(text).replace(/https?:\/\/[^\s<]*[^\s<.,;:!?)'"]/g, (url) => `<a href="${url}">${url}</a>`).replace(/\n/g, "<br>\n")}</div>`;

export const siteUrl = () => (process.env.CONVEX_SITE_URL ?? "").replace(/\/+$/, "");
export const unsubscribeUrl = (token: string) => `${siteUrl()}/u/${token}`;
export const fromHeader = (name: string | undefined, address: string) => { const clean = name?.replace(/["\r\n]/g, "").trim(); return clean ? `${/[,;:<>@()[\]\\.]/.test(clean) ? `"${clean}"` : clean} <${address}>` : address; };

// The campaign email as it goes out: rendered, with the postal address and an unsubscribe link.
export function compose(template: { subject: string; body: string }, recipient: Recipient, postalAddress: string, token: string) {
  const unsubscribe = unsubscribeUrl(token);
  const subject = render(template.subject, recipient).replace(/\s+/g, " ").trim();
  const text = `${render(template.body, recipient).trimEnd()}\n\n--\n${postalAddress}\nUnsubscribe: ${unsubscribe}`;
  return { subject, text, html: toHtml(text), headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
}

// Missing, unparseable or fractional means zero (AGENTS.md): nothing sends.
const whole = (raw: string | undefined) => { const text = raw?.trim() ?? "", n = Number(text); return /^\d+$/.test(text) && Number.isSafeInteger(n) ? n : 0; };
export const deploymentCap = () => whole(process.env.REMOLD_CAMPAIGN_DAILY_CAP);
export const senderDomains = () => (process.env.REMOLD_SENDER_DOMAINS ?? "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
export const inboundDomain = () => process.env.REMOLD_INBOUND_DOMAIN?.trim().toLowerCase() || undefined;

export type EmailSettings = { fromName?: string; fromAddress?: string; replyTo?: string; postalAddress?: string; dailyLimit?: number };
// What must be in place before anything sends. Secret values are never part of it.
export function checklist(settings: EmailSettings | undefined) {
  const domain = settings?.fromAddress?.split("@")[1]?.toLowerCase();
  return [
    { key: "apiKey", label: "Resend API key", ok: !!process.env.RESEND_API_KEY, missing: "The Resend API key is not set" },
    { key: "senderDomain", label: "From address on an allowed sender domain", ok: !!domain && senderDomains().includes(domain), missing: "The from address is not on an allowed sender domain" },
    { key: "postalAddress", label: "Postal address", ok: !!settings?.postalAddress, missing: "No postal address" },
    { key: "dailyLimit", label: "Daily limit", ok: (settings?.dailyLimit ?? 0) > 0, missing: "The daily limit is zero" },
    { key: "deploymentCap", label: "Deployment daily cap", ok: deploymentCap() > 0, missing: "The deployment daily cap is zero" },
    { key: "webhookSecret", label: "Webhook secret, so bounces and unsubscribes come back", ok: !!process.env.RESEND_WEBHOOK_SECRET, missing: "The webhook secret is not set" },
    { key: "inboundDomain", label: "Inbound domain for replies (optional)", ok: !!inboundDomain(), optional: true, missing: "" },
  ];
}
export const settingsProblems = (settings: EmailSettings | undefined) => checklist(settings).filter((item) => !item.optional && !item.ok).map((item) => item.missing);

// The reply itself: quoted lines and everything from "On ... wrote:" go.
export function replyPart(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n"), end = lines.findIndex((line) => /^\s*On\b.*\bwrote:\s*$/.test(line));
  return (end < 0 ? lines : lines.slice(0, end)).filter((line) => !line.trimStart().startsWith(">")).join("\n").trim();
}

// Svix, as Resend signs webhooks: HMAC-SHA256 over "id.timestamp.body" with the
// base64 key after "whsec_", any "v1,<sig>" may match, five minutes either way.
export async function verifySvix(secret: string, headers: Headers, body: string, now: number) {
  const id = headers.get("svix-id"), timestamp = headers.get("svix-timestamp"), signatures = headers.get("svix-signature");
  if (!id || !timestamp || !signatures || !/^\d{1,12}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  let raw: Uint8Array<ArrayBuffer>;
  try { raw = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0)); } catch { return false; }
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  const expected = btoa(String.fromCharCode(...mac));
  return signatures.split(" ").some((part) => { const [version, signature] = part.split(","); return version === "v1" && !!signature && sameText(signature, expected); });
}
function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// One POST to Resend. 429, 5xx and network trouble may be retried; anything else is final.
export type Outcome = { ok: true; id: string } | { ok: false; retry: boolean; reason: string };
export async function resendPost(body: Record<string, unknown>, idempotencyKey: string): Promise<Outcome> {
  try {
    const response = await fetch("https://api.resend.com/emails", { method: "POST", redirect: "error", headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    const json = await response.json().catch(() => ({})) as { id?: string; message?: string };
    if (response.ok && json.id) return { ok: true, id: json.id };
    return { ok: false, retry: response.status === 429 || response.status >= 500, reason: `Resend ${response.status}${json.message ? `: ${String(json.message).slice(0, 120)}` : ""}` };
  } catch { return { ok: false, retry: true, reason: "Resend request did not complete" }; }
}
