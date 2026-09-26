import type { Doc } from '../_generated/dataModel';
import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Principal } from '../identity';
import { canReadRecord, canReadRecordId } from './reads';
export function unrestrictedHuman(principal: Principal) {
  return 'member' in principal && principal.member.readScopes === undefined && !principal.member.hiddenFieldIds?.length;
}
export function sharedInboxReader(principal: Principal) {
  if ('member' in principal) return unrestrictedHuman(principal);
  const a = principal.agent, old = a.authorityVersion === undefined && principal.org.authorityFrozenAt !== undefined && a._creationTime <= principal.org.authorityFrozenAt;
  return (a.sharedInbox ?? old) && !a.hiddenFieldIds?.length && (old || !!a.readObjectIds?.length) && !(principal.capabilities ?? []).some(g => g.capability === 'read' || g.capability === 'propose');
}
export function canSeeInbox(principal: Principal, item: Doc<'agentInbox'>) {
  if (item.orgId !== principal.org._id) return false;
  if (item.from.kind === principal.actor.kind && item.from.id === principal.actor.id) return true;
  if (unrestrictedHuman(principal)) return true;
  const audience = item.audience ?? (principal.org.authorityFrozenAt !== undefined && item._creationTime <= principal.org.authorityFrozenAt ? 'org' : 'author');
  return audience === 'org' && sharedInboxReader(principal);
}
export async function visibleInbox(ctx: QueryCtx | MutationCtx, principal: Principal, item: Doc<'agentInbox'>) {
  if (!canSeeInbox(principal, item)) return null;
  let recordId = item.recordId, suggestionId = item.suggestionId;
  if (recordId) {
    const record = await ctx.db.get(recordId), object = record ? await ctx.db.get(record.objectId) : null;
    if (!record || !object || !canReadRecord(principal, object, record)) recordId = undefined;
  }
  if (suggestionId) {
    const suggestion = await ctx.db.get(suggestionId), object = suggestion ? await ctx.db.get(suggestion.change.objectId) : null;
    if (!suggestion || !object || !canReadRecordId(principal, object, suggestion.change.recordId)) suggestionId = undefined;
  }
  return { ...item, recordId, suggestionId };
}
