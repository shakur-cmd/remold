import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { fail } from "./errors";

const profile = v.object({ name: v.optional(v.string()), email: v.optional(v.string()), imageUrl: v.optional(v.string()) });

// The signed-in app supplies display profile fields for its authenticated caller.
// Membership and identity are derived from the verified token, never this profile.
export const store = mutation({ args: { profile: v.optional(profile) }, handler: async (ctx, args) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) fail("UNAUTHENTICATED", "Sign in first");
  const existing = await ctx.db.query("users").withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier)).unique();
  const sent = args.profile ?? {};
  const name = sent.name?.trim() || identity.name || [identity.givenName, identity.familyName].filter(Boolean).join(" ") || sent.email || identity.email || identity.nickname || existing?.name || "Member";
  const data = { name, email: sent.email ?? identity.email ?? existing?.email, imageUrl: sent.imageUrl ?? identity.pictureUrl ?? existing?.imageUrl };
  if (existing) { await ctx.db.patch(existing._id, data); return existing._id; }
  return ctx.db.insert("users", { tokenIdentifier: identity.tokenIdentifier, ...data });
} });

export const me = query({ args: {}, handler: async (ctx) => {
  const identity = await ctx.auth.getUserIdentity();
  return identity ? ctx.db.query("users").withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier)).unique() : null;
} });
