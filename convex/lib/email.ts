declare const process: { env: Record<string, string | undefined> };

export type Mail = { to: string; subject: string; text: string };
export type Sent = "sent" | "refused" | "unconfigured" | "failed";

const SEND_TIMEOUT_MS = 10_000;
let warnedUnconfigured = false;

// Only addresses listed in REMOLD_EMAIL_ALLOWLIST may receive mail; an unset list allows nobody.
export function allowed(to: string, list = process.env.REMOLD_EMAIL_ALLOWLIST) {
  const address = to.trim().toLowerCase();
  return /^[^\s@,;<>]+@[^\s@,;<>]+$/.test(address) && (list ?? "").split(",").some((entry) => entry.trim().toLowerCase() === address);
}

export const configured = () => !!process.env.RESEND_API_KEY && !!process.env.REMOLD_EMAIL_FROM;

// Plain-text mail through the Resend HTTP API, for actions only. Never throws:
// callers learn the outcome and carry on. Logs name only the recipient's domain.
export async function sendEmail(mail: Mail): Promise<Sent> {
  if (!allowed(mail.to)) { console.warn(`email refused: recipient @${mail.to.split("@").pop()} is not on REMOLD_EMAIL_ALLOWLIST`); return "refused"; }
  if (!configured()) {
    if (!warnedUnconfigured) { warnedUnconfigured = true; console.warn("email not sent: RESEND_API_KEY or REMOLD_EMAIL_FROM is not set"); }
    return "unconfigured";
  }
  try {
    const response = await fetch("https://api.resend.com/emails", { method: "POST", redirect: "error", headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ from: process.env.REMOLD_EMAIL_FROM, to: [mail.to.trim()], subject: mail.subject, text: mail.text }), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    if (response.ok) return "sent";
    console.warn(`email failed: Resend returned ${response.status}`);
  } catch { console.warn("email failed: Resend request did not complete"); }
  return "failed";
}
