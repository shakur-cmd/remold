import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { capability, scope, payload, adapterScope } from './contract';
export default defineSchema({
    budgets: defineTable({ cap: v.number(), reserved: v.number(), spent: v.number(), maxConcurrent: v.number(), active: v.number() }),
    orgs: defineTable({ name: v.string(), budget: v.id('budgets'), missingUsage: v.boolean(), readonly: v.boolean(), cap: v.number(), reserved: v.number(), spent: v.number(), maxConcurrent: v.number(), active: v.number() }),
    actors: defineTable({ org: v.id('orgs'), name: v.string(), kind: v.union(v.literal('human'), v.literal('agent')), state: v.union(v.literal('active'), v.literal('fired')), epoch: v.number() }),
    sessions: defineTable({ token: v.string(), actor: v.optional(v.id('actors')), adapterScope: v.optional(adapterScope) }).index('token', ['token']),
    grants: defineTable({ org: v.id('orgs'), actor: v.id('actors'), grantor: v.id('actors'), grantorEpoch: v.number(), parent: v.optional(v.id('grants')), capability, scope, mode: v.union(v.literal('propose'), v.literal('direct')), delegate: v.boolean(), expires: v.number(), revokedAt: v.optional(v.number()) }),
    bindings: defineTable({ org: v.id('orgs'), provider: v.string(), environment: v.string(), account: v.string(), kind: v.string(), externalId: v.string(), local: v.string(), healthy: v.boolean() }).index('key', ['provider', 'environment', 'account', 'kind', 'externalId']),
    operations: defineTable({ org: v.id('orgs'), author: v.id('actors'), actor: v.id('actors'), owner: v.id('actors'), adoptedFrom: v.optional(v.id('operations')), capability, logical: v.string(), binding: v.id('bindings'), payload, reservationUnits: v.number(), step: v.number(), maxSteps: v.number(), usage: v.number(), version: v.number(), actorEpoch: v.number(), state: v.union(...['proposed', 'approved', 'queued', 'dispatching', 'confirmed', 'refused', 'paused', 'cancellationPending', 'cancelled', 'outcomeUnknown'].map(x => v.literal(x))), approval: v.optional(v.object({ snapshot: payload, version: v.number(), expires: v.number(), actorEpoch: v.number(), approver: v.union(v.object({ actor: v.id('actors') }), v.object({ grant: v.id('grants') })) })), grant: v.optional(v.id('grants')), fence: v.number(), worker: v.optional(v.string()), leaseUntil: v.number(), permitUntil: v.number(), permitUsed: v.boolean(), reserved: v.number(), settled: v.boolean(), providerRef: v.optional(v.string()), late: v.boolean(), attempts: v.number() }).index('logical', ['org', 'logical']),
    consent: defineTable({ org: v.id('orgs'), recipient: v.string(), purpose: v.string(), channel: v.string(), suppressed: v.boolean(), version: v.number(), source: v.string(), at: v.number() }).index('recipient', ['org', 'recipient', 'purpose', 'channel']),
    events: defineTable({ org: v.id('orgs'), actor: v.string(), kind: v.string(), resource: v.string(), at: v.number() }),
    callbacks: defineTable({ binding: v.id('bindings'), eventId: v.string(), digest: v.string() }).index('key', ['binding', 'eventId']),
    observations: defineTable({ binding: v.id('bindings'), version: v.number(), state: v.string() }),
    provisions: defineTable({ org: v.id('orgs'), binding: v.id('bindings'), intent: v.string(), deleted: v.boolean(), externalId: v.optional(v.string()), cleanup: v.boolean() }),
    cursors: defineTable({ binding: v.id('bindings'), checkpoint: v.number(), traversal: v.string(), page: v.number(), items: v.array(v.string()), complete: v.boolean() }),
    records: defineTable({ org: v.id('orgs'), object: v.string(), public: v.string(), secret: v.string() }),
});
