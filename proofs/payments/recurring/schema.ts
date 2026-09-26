import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import base from './payment_schema';
const line = v.union(v.null(), v.object({
    id: v.string(),
    subscriptionItem: v.string(),
    price: v.string(),
    serviceStart: v.number(),
    serviceEnd: v.number()
}));
const state = v.union(...['prepared', 'activating', 'active', 'outcomeUnknown', 'cancelRequested', 'cancellationPending', 'ended', 'cancelled'].map(v.literal));
export default defineSchema({
    ...base.tables,
    recurringPlans: defineTable({
        org: v.id('orgs'),
        binding: v.id('bindings'),
        customer: v.id('payCustomers'),
        author: v.id('actors'),
        service: v.string(),
        version: v.number(),
        price: v.string(),
        setupIntent: v.string(),
        testClock: v.optional(v.string()),
        interval: v.union(v.literal('day'), v.literal('month')),
        start: v.number(),
        amountMinor: v.literal(301),
        cycles: v.literal(3),
        currency: v.literal('usd'),
        hash: v.string(),
        tokenHash: v.optional(v.string()),
        expires: v.optional(v.number()),
        acceptedAt: v.optional(v.number())
    }).index('version', ['customer', 'service', 'version']),
    recurringCommitments: defineTable({
        org: v.id('orgs'),
        binding: v.id('bindings'),
        customer: v.id('payCustomers'),
        plan: v.id('recurringPlans'),
        service: v.string(),
        actor: v.id('actors'),
        actorEpoch: v.number(),
        session: v.id('sessions'),
        author: v.id('actors'),
        generation: v.number(),
        state,
        capMinor: v.literal(903),
        reservedMinor: v.number(),
        paidMinor: v.number(),
        schedule: v.optional(v.string()),
        subscription: v.optional(v.string()),
        subscriptionItem: v.optional(v.string()),
        recognizedMinor: v.number(),
        providerEnd: v.optional(v.number()),
        observation: v.number(),
        complete: v.boolean(),
        anomaly: v.optional(v.string()),
        cancelRequested: v.boolean()
    }).index('service', ['customer', 'service', 'generation']).index('schedule', ['binding', 'schedule']),
    recurringCommands: defineTable({
        org: v.id('orgs'),
        commitment: v.id('recurringCommitments'),
        kind: v.union(v.literal('activate'), v.literal('card'), v.literal('cancel')),
        actor: v.id('actors'),
        actorEpoch: v.number(),
        session: v.id('sessions'),
        setupIntent: v.optional(v.string()),
        expires: v.number(),
        state: v.union(v.literal('prepared'), v.literal('consumed'), v.literal('unknown'), v.literal('confirmed')),
        providerRef: v.optional(v.string()),
        late: v.boolean()
    }).index('commitment', ['commitment', 'kind']),
    recurringCycles: defineTable({
        commitment: v.id('recurringCommitments'),
        binding: v.id('bindings'),
        invoice: v.string(),
        subscription: v.string(),
        period: v.number(),
        line,
        observedLine: line,
        lineDecision: v.union(v.literal('unidentified'), v.literal('valid'), v.literal('invalid')),
        cycleIndex: v.optional(v.number()),
        anomaly: v.optional(v.string()),
        observedPaidMinor: v.number(),
        amountMinor: v.number(),
        paidMinor: v.number(),
        status: v.string(),
        autoAdvance: v.boolean(),
        payments: v.array(v.object({
            eligible: v.optional(v.boolean()),
            invoicePayment: v.optional(v.string()),
            id: v.string(),
            amountMinor: v.number(),
            status: v.union(v.literal('pending'), v.literal('succeeded'), v.literal('failed'), v.literal('cancelled'))
        }))
    }).index('commitment', ['commitment']).index('invoice', ['binding', 'invoice']).index('binding', ['binding'])
});
