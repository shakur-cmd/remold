import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireMember, requireWriter } from "./identity";
import { fail } from "./errors";
import { applyChange } from "./lib/applyChange";
import { campaignReport, emailPreview, markReplied as mark, standardItem } from "./lib/campaign";
import { checklist, validAddress } from "./lib/campaignText";

// Campaign email for people in the app. Agents reach the same report, preview and
// "mark replied" through agentApi; the sender itself is convex/campaignSend.ts.

export const settings = query({ args: { orgId: v.id("orgs") }, handler: async (ctx, args) => {
  const { org } = await requireMember(ctx, args.orgId, "admin");
  return { settings: org.emailSettings ?? {}, checklist: checklist(org.emailSettings).map(({ missing: _, ...item }) => item) };
} });

// Only the keys given change; an empty string clears one.
export const saveSettings = mutation({ args: { orgId: v.id("orgs"), fromName: v.optional(v.string()), fromAddress: v.optional(v.string()), replyTo: v.optional(v.string()), postalAddress: v.optional(v.string()), dailyLimit: v.optional(v.number()) }, handler: async (ctx, { orgId, ...change }) => {
  const { org } = await requireWriter(ctx, orgId, "admin");
  const next: Record<string, string | number | undefined> = { ...org.emailSettings };
  for (const [key, raw] of Object.entries(change)) {
    if (typeof raw === "number") { if (!Number.isSafeInteger(raw) || raw < 0) fail("VALIDATION", "The daily limit must be a whole number, zero or more"); next[key] = raw; continue; }
    const text = raw.trim().slice(0, 500);
    if (text && (key === "fromAddress" || key === "replyTo") && !validAddress(text.toLowerCase())) fail("VALIDATION", `${key === "fromAddress" ? "From" : "Reply-to"} address is not a valid email address`);
    next[key] = text ? (key === "fromAddress" || key === "replyTo" ? text.toLowerCase() : text) : undefined;
  }
  await ctx.db.patch(orgId, { emailSettings: Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) });
} });

export const report = query({ args: { orgId: v.id("orgs"), campaignId: v.id("records") }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId), campaign = await ctx.db.get(args.campaignId);
  if (!campaign || campaign.orgId !== args.orgId) fail("NOT_FOUND", "Campaign not found");
  return campaignReport(ctx, principal, campaign);
} });

export const preview = query({ args: { orgId: v.id("orgs"), emailId: v.id("records"), personId: v.optional(v.id("records")) }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId), email = await ctx.db.get(args.emailId);
  if (!email || email.orgId !== args.orgId) fail("NOT_FOUND", "Email not found");
  return emailPreview(ctx, principal, email, args.personId);
} });

// Approval from the campaign page, where the admin confirms the list agreed to hear
// from them. The status change goes through applyChange, which checks the email.
export const approve = mutation({ args: { orgId: v.id("orgs"), emailId: v.id("records"), confirmed: v.boolean() }, handler: async (ctx, args) => {
  const member = await requireWriter(ctx, args.orgId, "admin"), item = await standardItem(ctx, args.orgId, "email"), email = await ctx.db.get(args.emailId);
  if (!item?.f.status || !email || email.orgId !== args.orgId || email.objectId !== item.object._id) fail("NOT_FOUND", "Email not found");
  if (["sending", "sent"].includes(email.values[item.f.status._id] as string)) fail("CONFLICT", "This email is already going out");
  if (!args.confirmed) fail("VALIDATION", "Confirm that everyone on this list agreed to hear from you or already works with you");
  await applyChange(ctx, member, { action: "update", orgId: args.orgId, recordId: email._id, values: { [item.f.status._id]: "approved" }, reason: "Approved for sending" });
  const run = await ctx.db.query("emailRuns").withIndex("by_email", (q) => q.eq("emailRecordId", email._id)).unique();
  if (!run) fail("CONFLICT", "This email is not waiting to send");
  await ctx.db.patch(run._id, { confirmed: true, approvedBy: member.user._id, approvedAt: Date.now() });
} });

export const markReplied = mutation({ args: { orgId: v.id("orgs"), sendId: v.string() }, handler: async (ctx, args) => mark(ctx, await requireWriter(ctx, args.orgId), args.sendId) });
