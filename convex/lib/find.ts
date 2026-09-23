import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

// Exact, case-insensitive name match within one object. The search index
// narrows candidates; the exact comparison decides.
export async function findByTitle(ctx: QueryCtx, orgId: Id<"orgs">, objectId: Id<"objects">, title: string) {
  const want = title.trim().toLowerCase();
  if (!want) return null;
  const hits = await ctx.db.query("records").withSearchIndex("search_title", (q) => q.search("title", title).eq("orgId", orgId).eq("objectId", objectId)).take(20);
  return hits.find((record) => record.title.trim().toLowerCase() === want) ?? null;
}
