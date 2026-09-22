import { mutation, query } from "./_generated/server";
import { fail } from "./errors";

export const store = mutation({ args: {}, handler: async (ctx) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) fail("UNAUTHENTICATED", "Sign in first");
  const existing = await ctx.db.query("users").withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier)).unique();
  const data = { name: identity.name ?? "", email: identity.email, imageUrl: identity.pictureUrl };
  if (existing) { await ctx.db.patch(existing._id, data); return existing._id; }
  return ctx.db.insert("users", { tokenIdentifier: identity.tokenIdentifier, ...data });
} });

export const me = query({ args: {}, handler: async (ctx) => {
  const identity = await ctx.auth.getUserIdentity();
  return identity ? ctx.db.query("users").withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier)).unique() : null;
} });
