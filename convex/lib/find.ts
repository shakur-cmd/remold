import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { Principal } from "../identity";
import { canReadRecord } from "../authority/reads";

// Exact, case-insensitive name match within one object. The search index
// narrows candidates; the exact comparison decides.
export async function findByTitle(ctx: QueryCtx, orgId: Id<"orgs">, objectId: Id<"objects">, title: string) {
  const want = title.trim().toLowerCase();
  if (!want) return null;
  const hits = await ctx.db.query("records").withSearchIndex("search_title", (q) => q.search("title", title).eq("orgId", orgId).eq("objectId", objectId)).take(20);
  return hits.find((record) => record.title.trim().toLowerCase() === want) ?? null;
}

// Name matching on behalf of a principal. A record they cannot read is treated
// exactly like no record, so the outcome never reveals that the name exists.
export async function findReadableByTitle(ctx: QueryCtx, principal: Principal, object: Doc<"objects">, title: string) {
  const want = title.trim().toLowerCase();
  if (!want) return null;
  const hits = await ctx.db.query("records").withSearchIndex("search_title", (q) => q.search("title", title).eq("orgId", principal.org._id).eq("objectId", object._id)).take(20);
  return hits.find((record) => record.title.trim().toLowerCase() === want && canReadRecord(principal, object, record)) ?? null;
}
