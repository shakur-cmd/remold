import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import base from './payment_schema';
// Additive tables for callback ingestion; the frozen payment schema is imported unchanged.
export default defineSchema({
    ...base.tables,
    callbackIngress: defineTable({ tokenHash: v.string() }).index('token', ['tokenHash']),
    callbackParked: defineTable({ account: v.string(), eventId: v.string(), type: v.string(), digest: v.string(), at: v.number() }).index('key', ['account', 'eventId']),
    callbackAlerts: defineTable({ kind: v.string(), account: v.string(), count: v.number(), firstAt: v.number(), lastAt: v.number(), lastEventId: v.string(), resolvedAt: v.optional(v.number()) }).index('key', ['kind', 'account']),
    // One schedule row per admitted open receipt, selected by next-due time so waiting receipts are never scanned.
    callbackRetries: defineTable({ binding: v.id('bindings'), incoming: v.id('payIncoming'), attempts: v.number(), nextAt: v.number(), code: v.string() }).index('incoming', ['incoming']).index('due', ['binding', 'nextAt']),
    // Receipts created after seenUpTo have not been admitted to the schedule yet.
    callbackCursors: defineTable({ binding: v.id('bindings'), seenUpTo: v.number() }).index('binding', ['binding']),
});
