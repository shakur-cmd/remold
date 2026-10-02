import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { fail } from '../errors';

// A workspace being deleted, or still being staged by an import, is closed to everyone.
export const closed = (org: Doc<'orgs'>) => !!(org.deletingAt || org.importingAt);
// How long an export may hold its write fence; a stuck export releases the workspace on its own.
export const FENCE_MS = 5 * 60_000;

// The operator flag is an immediate safety hold; billing derives its entitlement
// independently and must use this same boundary before creating new work.
export async function writable(ctx: QueryCtx | MutationCtx, orgId: Id<'orgs'>) {
  const org = await ctx.db.get(orgId);
  if (!org || closed(org)) fail('NOT_FOUND', 'Workspace not found');
  if (org.flags?.readonly) fail('FORBIDDEN', 'Workspace is read only');
  if (org.exportingAt && Date.now() - org.exportingAt < FENCE_MS) fail('CONFLICT', 'This workspace is being exported; try again in a minute', { retryable: true });
  return org;
}
