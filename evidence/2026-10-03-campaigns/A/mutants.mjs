// Each mutant breaks one rule; the named test must then fail. The file is restored after each run.
// Run from the repo root: node evidence/2026-10-03-campaigns/A/mutants.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const mutants = [
  ["convex/lib/campaignText.ts", "ok: !!process.env.RESEND_WEBHOOK_SECRET", "ok: true", "webhook secret is set"],
  ["convex/lib/campaignText.ts", "ok: !!process.env.RESEND_API_KEY", "ok: true", "Resend API key is set"],
  ["convex/lib/campaignText.ts", "ok: !!domain && senderDomains().includes(domain)", "ok: !!domain", "from address is on an allowed domain"],
  ["convex/lib/campaignText.ts", "ok: !!settings?.postalAddress", "ok: true", "org has a postal address"],
  ["convex/lib/campaignText.ts", "ok: deploymentCap() > 0", "ok: true", "deployment has a daily cap"],
  ["convex/lib/campaign.ts", "if ((row?.used ?? 0) >= cap) return null;", "if ((row?.used ?? 0) > cap) return null;", "daily"],
  ["convex/lib/campaign.ts", 'else if (value(campaign, campaignItem.f.status) !== "active") problems.push("The campaign is not active");', "", "campaign is active"],
  ["convex/lib/campaign.ts", 'else if (!run?.confirmed) problems.push("Not approved on the campaign page with the list confirmed");', "", "person approved it"],
  ["convex/lib/campaign.ts", 'sendTo === "notOpened" && before.openedAt ? "opened" : ', "", "did not open"],
  ["convex/lib/campaign.ts", "if (!record || !person || !canReadRecord(principal, person.object, record)) continue;", "if (!record || !person) continue;", "as far as the key may read"],
  ["convex/campaignSend.ts", "if (state && !state.problems.length && !reason) return true;", "return true;", "mid-batch"],
  ["convex/campaignSend.ts", 'q.eq("status", "sending").lt("lease", now)', 'q.eq("status", "sending").lt("lease", 0)', "crashed"],
  ["convex/campaignSend.ts", 'if (a.type === "email.bounced" && a.bounce === "Permanent" && !send.bouncedAt)', 'if (a.type === "email.bounced" && !send.bouncedAt)', "temporary bounce"],
  ["convex/campaignSend.ts", 'if (request.method === "POST" && /^[a-f0-9]{32}$/.test(token))', "if (/^[a-f0-9]{32}$/.test(token))", "unsubscribe link asks first"],
  ["convex/campaignSend.ts", "if (!(await firstTime(ctx, a.eventId))) return;", "", "replayed event once"],
  ["convex/lib/campaignText.ts", "Math.abs(now / 1000 - Number(timestamp)) > 300", "false", "stale timestamp"],
  ["convex/authority/agentGuards.ts", "if (field === email && approved(to)) fail('FORBIDDEN', 'Only a person can approve an email', { fieldId: field._id });", "", "agent drafts emails"],
  ["convex/authority/agentGuards.ts", "if (approved(record?.values[email._id])) fail(", "if (false) fail(", "agent drafts emails"],
  ["convex/lib/emailRules.ts", "const bad = badTags(text(key)); if (bad.length)", "const bad = badTags(text(key)); if (false)", "merge tags"],
  ["convex/campaignSend.ts", "await addNote(ctx, send.orgId, send.personRecordId, a.text);", "", "inbound address"],
];
let caught = 0;
for (const [file, from, to, test] of mutants) {
  const original = readFileSync(file, "utf8");
  if (!original.includes(from)) { console.log(`MISSING  ${file}: ${from}`); continue; }
  writeFileSync(file, original.replace(from, to));
  const run = spawnSync("pnpm", ["vitest", "run", "convex/campaigns.test.ts", "-t", test], { encoding: "utf8" });
  writeFileSync(file, original);
  const failed = run.status !== 0 && /failed/.test(run.stdout);
  if (failed) caught++;
  console.log(`${failed ? "CAUGHT  " : "SURVIVED"} ${file} -> test "${test}"`);
}
console.log(`${caught}/${mutants.length} mutants caught`);
