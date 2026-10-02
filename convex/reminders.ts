declare const process: { env: Record<string, string | undefined> };
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireMember, requireWriter } from "./identity";
import { daily } from "./today";
import { sendEmail, type Sent } from "./lib/email";

// The daily reminder: each member who turned it on gets their own Today list by
// email, read with their own permissions, so nothing from another workspace or
// outside their read scope can appear. "Today" is the UTC date at send time.
const DAY = 24 * 60 * 60 * 1000;

export const mine = query({ args: { orgId: v.id("orgs") }, handler: async (ctx, args) => {
  const member = await requireMember(ctx, args.orgId);
  return { on: member.member.dailyReminder === true, email: member.user.email ?? null };
} });

// Turning the reminder off is always allowed, so a read-only hold cannot keep mail coming.
export const set = mutation({ args: { orgId: v.id("orgs"), on: v.boolean() }, handler: async (ctx, args) => {
  const member = args.on ? await requireWriter(ctx, args.orgId) : await requireMember(ctx, args.orgId);
  await ctx.db.patch(member.member._id, { dailyReminder: args.on });
} });

export const recipients = internalQuery({ args: {}, handler: async (ctx) => (await ctx.db.query("members").withIndex("by_reminders", (q) => q.eq("dailyReminder", true)).take(1000)).map((m) => m._id) });

const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const utcMidnight = (at: number) => at - (at % DAY);

// One reminder per member per UTC day: a run claims the day before sending and
// releases it if the send fails, so a later run that day can retry.
export const claim = internalMutation({ args: { memberId: v.id("members"), day: v.number() }, handler: async (ctx, args) => {
  const member = await ctx.db.get(args.memberId);
  if (!member?.dailyReminder || member.reminderSentOn === args.day) return false;
  await ctx.db.patch(member._id, { reminderSentOn: args.day });
  return true;
} });
export const release = internalMutation({ args: { memberId: v.id("members"), day: v.number() }, handler: async (ctx, args) => {
  const member = await ctx.db.get(args.memberId);
  if (member?.reminderSentOn === args.day) await ctx.db.patch(member._id, { reminderSentOn: undefined });
} });
const when = (at: number) => at % DAY ? `${day(at)} ${new Date(at).toISOString().slice(11, 16)} UTC` : day(at);

export const compose = internalQuery({ args: { memberId: v.id("members") }, handler: async (ctx, { memberId }) => {
  const member = await ctx.db.get(memberId);
  const [user, org] = member?.dailyReminder ? await Promise.all([ctx.db.get(member.userId), ctx.db.get(member.orgId)]) : [null, null];
  const today = utcMidnight(Date.now());
  if (!member || !user?.email || !org || member.reminderSentOn === today) return null;
  const list = await daily(ctx, { user, member, org, actor: { kind: "user", id: user._id } }, today + DAY);
  const dueOf = (r: Doc<"records">) => (list.task ? r.values[list.task.dueFieldId] : undefined) as number;
  const overdue = list.tasks.filter((r) => dueOf(r) < today), dueToday = list.tasks.filter((r) => dueOf(r) >= today);
  if (!list.tasks.length && !list.quiet.length) return null;
  const base = process.env.REMOLD_APP_URL?.replace(/\/+$/, ""), link = (path: string) => (base ? ` ${base}/o/${org._id}/${path}` : "");
  const line = (r: Doc<"records">, detail: string, key: string) => `- ${r.title || "(untitled)"} (${detail})${link(`${key}/${r._id}`)}`;
  const section = (title: string, rows: string[]) => (rows.length ? [title, ...rows, ""] : []);
  const text = [
    `Your Remold list for ${day(today)} in ${org.name}.`, "",
    ...section("Overdue", overdue.map((r) => line(r, `due ${when(dueOf(r))}`, list.task!.objectKey))),
    ...section("Due today", dueToday.map((r) => line(r, `due ${when(dueOf(r))}`, list.task!.objectKey))),
    ...section("Gone quiet (no update in two weeks)", list.quiet.map((r) => line(r, `last update ${day(r.updatedAt)}`, list.dealKey!))),
    ...(base ? [`Open Today:${link("today")}`, `Turn these emails off in Settings:${link("settings")}`] : ["Turn these emails off in Settings."]),
  ].join("\n");
  const counts = [overdue.length && `${overdue.length} overdue`, dueToday.length && `${dueToday.length} due today`, list.quiet.length && `${list.quiet.length} gone quiet`].filter(Boolean).join(", ");
  return { to: user.email, subject: `Remold: ${counts} (${org.name})`, text, day: today };
} });

export const send = internalAction({ args: {}, handler: async (ctx) => {
  const results: Partial<Record<Sent | "empty" | "error", number>> = {};
  const count = (key: Sent | "empty" | "error") => { results[key] = (results[key] ?? 0) + 1; };
  for (const memberId of await ctx.runQuery(internal.reminders.recipients, {})) {
    // One member's failure must not stop everyone else's reminder.
    try {
      const mail = await ctx.runQuery(internal.reminders.compose, { memberId });
      if (!mail || !(await ctx.runMutation(internal.reminders.claim, { memberId, day: mail.day }))) { count("empty"); continue; }
      const sent = await sendEmail(mail);
      if (sent !== "sent") await ctx.runMutation(internal.reminders.release, { memberId, day: mail.day });
      count(sent);
    } catch { count("error"); }
  }
  return results;
} });
