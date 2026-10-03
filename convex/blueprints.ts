import { action, internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { requireMember, requireWriter } from "./identity";
import { fail } from "./errors";
import { blueprint, requireUnrestricted } from "./lib/metadata";
import { diffOf, exportBlueprint, parseBlueprint, refusal, rollBack, runBlueprint, trialOf, type Applied } from "./lib/blueprint";
import { templates as builtIn } from "./lib/templates";
import { authorize } from "./shapeSuggestions";

// A person's side of blueprints: pick a template or paste one, see it as one diff, check it, apply it.
export const templates = query({ args: {}, handler: () => builtIn });
export const preview = query({ args: { orgId: v.id("orgs"), blueprint }, handler: async (ctx, args) => {
  const principal = await requireMember(ctx, args.orgId, "admin");
  await requireUnrestricted(ctx, principal);
  return diffOf(ctx, principal, parseBlueprint(args.blueprint));
} });
export const apply = mutation({ args: { orgId: v.id("orgs"), blueprint, withRecords: v.boolean() }, handler: async (ctx, args) => {
  const principal = await requireWriter(ctx, args.orgId, "admin"), result = await runBlueprint(ctx, principal, args.blueprint, { person: principal, records: args.withRecords });
  await ctx.db.insert("authorityAudit", { orgId: args.orgId, actor: principal.actor, action: "blueprintApplied", targetId: args.orgId, objectIds: result.objectIds, before: args.blueprint.name });
  return result;
} });
// The workspace's shape as a blueprint, limited to what the caller can read.
export const current = query({ args: { orgId: v.id("orgs") }, handler: async (ctx, args) => exportBlueprint(ctx, await requireMember(ctx, args.orgId)) });

// Runs the blueprint (a pasted one, or a waiting proposal's) and rolls it back: ok with the
// slot use after applying, or the first refusal in plain words.
export const trial = internalMutation({ args: { orgId: v.id("orgs"), blueprint: v.optional(blueprint), id: v.optional(v.id("shapeSuggestions")), withRecords: v.optional(v.boolean()) }, handler: async (ctx, args) => {
  const principal = await requireWriter(ctx, args.orgId, "admin"), row = args.id ? await ctx.db.get(args.id) : null;
  if (row) await authorize(ctx, principal, row);
  const agent = row ? await ctx.db.get(row.agentId) : null;
  const plan = row?.change.kind === "blueprint" ? row.change.blueprint : args.blueprint;
  if (!plan) fail("NOT_FOUND", "Blueprint not found");
  rollBack(await runBlueprint(ctx, principal, plan, { person: principal, records: args.withRecords === true, agent: agent ?? undefined }));
} });
export const check = action({ args: { orgId: v.id("orgs"), blueprint: v.optional(blueprint), id: v.optional(v.id("shapeSuggestions")), withRecords: v.optional(v.boolean()) }, handler: async (ctx, args): Promise<{ ok: true; slots: Applied["slots"]; records: number } | { ok: false; error: string }> => {
  try { const { slots, records } = await trialOf(() => ctx.runMutation(internal.blueprints.trial, args)); return { ok: true, slots, records }; }
  catch (error) { const message = refusal(error); if (!message) throw error; return { ok: false, error: message }; }
} });
