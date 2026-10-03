import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { Principal } from "../identity";
import { canReadRecord, listedRecords } from "../authority/reads";

// Name matching on behalf of a principal. A record they cannot read is treated
// exactly like no record, so the outcome never reveals that the name exists.
export async function findReadableByTitle(ctx: QueryCtx, principal: Principal, object: Doc<"objects">, title: string) {
  const want = title.trim().toLowerCase();
  if (!want) return null;
  // A record-scoped caller is matched against their own list; anyone else can read
  // every record of the object, so the index's candidates hide nothing.
  const listed = await listedRecords(ctx, principal, object);
  if (listed) return listed.filter(record => record.title.trim().toLowerCase() === want).sort((a, b) => a._creationTime - b._creationTime)[0] ?? null;
  const hits = await ctx.db.query("records").withSearchIndex("search_title", (q) => q.search("title", title).eq("orgId", principal.org._id).eq("objectId", object._id)).take(20);
  return hits.find((record) => record.title.trim().toLowerCase() === want && canReadRecord(principal, object, record)) ?? null;
}
