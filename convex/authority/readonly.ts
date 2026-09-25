import type { Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { fail } from '../errors';

// The operator flag is an immediate safety hold; billing derives its entitlement
// independently and must use this same boundary before creating new work.
export async function writable(ctx: QueryCtx | MutationCtx, orgId: Id<'orgs'>) {
  const org = await ctx.db.get(orgId);
  if (!org) fail('NOT_FOUND', 'Workspace not found');
  if (org.flags?.readonly) fail('FORBIDDEN', 'Workspace is read only');
  return org;
}
