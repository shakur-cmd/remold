import { mutation, query } from "./_generated/server";
export const insert = mutation({ args: {}, handler: async (ctx) => {
  await ctx.db.insert("objects", { name: "base" });
  // untyped table names so this file compiles under schema B too
  const db = ctx.db as any;
  await db.insert("setupProposals", { title: "p1" });
  await db.insert("setupEvents", { kind: "e1" });
  return "ok";
}});
export const counts = query({ args: {}, handler: async (ctx) => {
  const db = ctx.db as any;
  const out: Record<string, number> = {};
  for (const t of ["objects", "setupProposals", "setupEvents"]) out[t] = (await db.query(t).collect()).length;
  return out;
}});
