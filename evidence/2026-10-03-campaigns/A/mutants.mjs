// Each mutant breaks one rule; the named test must then fail. The file is restored after each run.
// Round 1 list, the independent verifier's 13 (~/scratch/iv-A-mutants.mjs), and round 2's.
// Run from the repo root: node evidence/2026-10-03-campaigns/A/mutants.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const T = "convex/lib/campaignText.ts", C = "convex/lib/campaign.ts", S = "convex/campaignSend.ts", R = "convex/lib/emailRules.ts", G = "convex/authority/agentGuards.ts", A = "convex/campaigns.ts", AC = "convex/lib/applyChange.ts";
const mutants = [
  // Round 1
  [T, "ok: !!process.env.RESEND_WEBHOOK_SECRET", "ok: true", "webhook secret is set"],
  [T, "ok: !!process.env.RESEND_API_KEY", "ok: true", "Resend API key is set"],
  [T, "ok: !!domain && senderDomains().includes(domain)", "ok: !!domain", "from address is on an allowed domain"],
  [T, "ok: !!settings?.postalAddress", "ok: true", "org has a postal address"],
  [C, "if ((row?.used ?? 0) >= cap) return null;", "if ((row?.used ?? 0) > cap) return null;", "daily"],
  [C, 'else if (value(campaign, campaignItem.f.status) !== "active") problems.push("The campaign is not active");', "", "campaign is active"],
  [C, "else if (!run?.confirmed) problems.push(NOT_CONFIRMED);", "", "confirmation withdrawn mid-batch"],
  [C, 'if (previous && sendTo === "notOpened" && previous.openedAt) return { reason: "opened", wrote };', "", "did not open"],
  [C, "if (!record || !person || !canReadRecord(principal, person.object, record)) continue;", "if (!record || !person) continue;", "as far as the key may read"],
  [S, "if (state && !state.problems.length && !reason) return true;", "return true;", "mid-batch"],
  [S, 'q.eq("status", "sending").lt("lease", now)', 'q.eq("status", "sending").lt("lease", 0)', "crashed"],
  [S, 'if (a.type === "email.bounced" && a.bounce === "Permanent" && !send.bouncedAt)', 'if (a.type === "email.bounced" && !send.bouncedAt)', "temporary bounce"],
  [S, 'if (request.method === "POST" && /^[a-f0-9]{32}$/.test(token))', "if (/^[a-f0-9]{32}$/.test(token))", "unsubscribe link asks first"],
  [S, "  if (!(await firstTime(ctx, a.eventId))) return;\n  const tagged", "  const tagged", "replayed event once"],
  [T, "Math.abs(now / 1000 - Number(timestamp)) > 300", "false", "stale timestamp"],
  [G, "if (field === email && approved(to)) fail('FORBIDDEN', 'Only a person can approve an email', { fieldId: field._id });", "", "agent drafts emails"],
  [G, "if (approved(record?.values[email._id])) fail(", "if (false) fail(", "agent drafts emails"],
  [R, "const bad = badTags(text(key)); if (bad.length)", "const bad = badTags(text(key)); if (false)", "merge tags"],
  [S, "await addNote(ctx, send.orgId, send.personRecordId, a.text);", "", "inbound address"],
  // Independent verifier
  [C, "const day = Math.floor(now / DAY), keys = [[`${day}:${orgId}`, limit], [`${day}:all`, deploymentCap()]] as const;", "const day = Math.floor(now / DAY), keys = [[`${day}:${orgId}`, limit]] as const;", "deployment's daily cap"],
  [T, '"idempotency-key": idempotencyKey', '"x-nope": idempotencyKey', "crashed"],
  [T, 'raw = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));', 'raw = new TextEncoder().encode(secret.replace(/^whsec_/, ""));', "refuses a missing secret"],
  [T, "new TextEncoder().encode(`${id}.${timestamp}.${body}`)", "new TextEncoder().encode(`${id}.${body}`)", "refuses a missing secret"],
  [C, 'for (const [key, reason] of [["bouncedAt", "bounced"], ["complainedAt", "complained"], ["unsubscribedAt", "unsubscribed"]] as const) if (past.some((send) => send[key])) return reason;', "", "even without a consent row"],
  [S, "if (!send || send.status !== \"sending\" || send.attempts !== attempt) return;", "if (!send || send.status !== \"sending\") return;", "late finish"],
  [R, 'if (!engine && (!("member" in principal) || principal.member.role === "member")) fail("FORBIDDEN", "Only an admin can approve an email");', "", "plain member cannot approve"],
  [S, "if (!send || send.status !== \"sending\" || send.attempts !== attempt) return false;", "return true;", "mid-batch"],
  [C, 'if (org.flags?.readonly) problems.push("The workspace is read only");', "", "read-only workspace sends nothing"],
  [C, "const address = person.f.email && canReadField(principal, person.object, person.f.email, record._id) ? s.to || null : null;", "const address = s.to || null;", "as far as the key may read"],
  [S, 'if (!send || send.status !== "sent") return;\n  if (!send.repliedAt)', "if (!send) return;\n  if (!send.repliedAt)", "never went out"],
  [T, "if (a.length !== b.length) return false;", "", "refuses a missing secret"],
  [T, "text = `${render(template.body, recipient).trimEnd()}\\n\\n--\\n${postalAddress}\\nUnsubscribe: ${unsubscribe}`", "text = `${render(template.body, recipient).trimEnd()}`", "footer, unsubscribe headers"],
  // Round 2
  [R, 'if (live && !entering && WATCHED.some((key) => f[key] && !same(before?.[f[key]._id], after[f[key]._id]))) return "withdraw";', "", "back to draft"],
  [A, "if (approvalVersion(content, people) !== args.version) fail(", "if (false) fail(", "changed after the preview"],
  [A, "await snapshot(ctx, (await ctx.db.get(email._id))!, item, people);", "", "sends an approved email once"],
  [C, 'else if (status !== "sent" && run.contentVersion !== contentVersion(email, item, org.emailSettings)) problems.push(CHANGED);', "", "reply-to address"],
  [AC, "  await emailCheck(ctx, membership, actor, object, fields, record?.values ?? null, values, record?._id);\n", "", "CSV row"],
  [C, "campaignId && past.some((send) => send.repliedAt && send.campaignRecordId === campaignId)", "past.some((send) => send.repliedAt)", "that campaign's later emails only"],
  [S, "if (send.uncertain && (send.firstAttemptAt ?? now) < now - UNKNOWN_AFTER) { await ctx.db.patch(send._id, { status: \"failed\", failReason: UNKNOWN }); continue; }", "", "sat paused for 23 hours"],
  [S, "const uncertain = send.uncertain || outcome.unknown === true;\n    if (!uncertain) await release(ctx, send.orgId, send.reservedDay);", "const uncertain = send.uncertain || outcome.unknown === true;\n    await release(ctx, send.orgId, send.reservedDay);", "answer is lost"],
  [S, "let payload = send.uncertain ? send.payload : undefined;", "let payload: string | undefined = undefined;", "uncertain retry keeps both"],
  [S, "let payload = send.uncertain ? send.payload : undefined;", "let payload = send.payload;", "composed again from what was last approved"],
  [S, "key: `${send._id}:${fingerprint(payload)}`", "key: send._id", "under a new key"],
  [C, "else if (status !== \"sent\" && run.contentVersion", "else if (run.contentVersion", "never shows as changed since approval"],
  [S, "if (forward.lease && !forward.uncertain) await ctx.db.patch(forward._id, { uncertain: true });", "", "forward whose action died"],
  [S, "await ctx.db.patch(run._id, { checkedAt: now });", "", "starve"],
  [S, "FORWARDS_PER_SEND = 3", "FORWARDS_PER_SEND = 100", "once per Resend email"],
  [S, " || !(await firstTime(ctx, `received:${a.emailId}`))", "", "once per Resend email"],
  [S, "if (!org || org.flags?.readonly || settingsProblems(org.emailSettings).length) continue;", "if (!org || settingsProblems(org.emailSettings).length) continue;", "read-only workspace holds it"],
  [S, "const day = forward.reservedDay ?? await reserve(ctx, org._id, org.emailSettings?.dailyLimit ?? 0, now);", "const day = forward.reservedDay ?? 0;", "forwards use the daily limit"],
  [S, "if (send.status !== \"sent\" && send.uncertain && a.providerId", "if (false && a.providerId", "settles it as sent"],
  [C, 'subject: readable("subject") ? String(value(email, item.f.subject) ?? "") : ""', 'subject: String(value(email, item.f.subject) ?? "")', "hides the email subject"],
  [C, 'body: readable("body") ? String(value(email, item.f.body) ?? "") : ""', 'body: String(value(email, item.f.body) ?? "")', "hides the email body"],
  [C, 'return { name: readable("name") ? record.title : "",', "return { name: record.title,", "hides the person name"],
  [C, 'const companyId = readable("company") ? (value(record, person.f.company) as Id<"records"> | undefined) : undefined', 'const companyId = value(record, person.f.company) as Id<"records"> | undefined', "hides the person company"],
  [C, "company: company ? (await visibleTitle(ctx, principal, company)) || undefined : undefined", "company: company?.title || undefined", "hides the company name"],
];
let caught = 0;
for (const [file, from, to, test] of mutants) {
  const original = readFileSync(file, "utf8");
  if (!original.includes(from)) { console.log(`MISSING  ${file}: ${from.slice(0, 80)}`); continue; }
  writeFileSync(file, original.replace(from, to));
  const run = spawnSync("node", ["node_modules/vitest/vitest.mjs", "run", "convex/campaigns.test.ts", "-t", test], { encoding: "utf8" });
  writeFileSync(file, original);
  const failed = run.status !== 0 && /failed/.test(run.stdout);
  if (failed) caught++;
  console.log(`${failed ? "CAUGHT  " : "SURVIVED"} ${file} -> test "${test}"`);
}
console.log(`${caught}/${mutants.length} mutants caught`);
