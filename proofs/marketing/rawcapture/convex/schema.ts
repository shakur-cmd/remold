import {defineSchema,defineTable} from 'convex/server';
import {v} from 'convex/values';
export const tenant=v.union(v.literal('a'),v.literal('b'));
export const role=v.union(v.literal('edge'),v.literal('reconciler'));
export const outcome=v.union(v.literal('created'),v.literal('existing'),v.literal('ambiguous'));
export default defineSchema({
 // Only SHA-256 of each credential is stored. The tenant comes from the credential, never from the caller.
 keys:defineTable({keyHash:v.string(),tenant,role}).index('by_hash',['keyHash']),
 // Captured values are suggestions from an unauthenticated public form: never consent, never a profile overwrite.
 captures:defineTable({tenant,idempotencyKey:v.string(),payloadSha256:v.string(),email:v.string(),firstname:v.string(),receivedAt:v.number(),status:v.union(v.literal('pending'),v.literal('settled')),outcome:v.optional(outcome),contactId:v.optional(v.number())})
  .index('by_key',['tenant','idempotencyKey']).index('by_status',['tenant','status']),
});
