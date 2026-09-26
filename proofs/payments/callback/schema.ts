import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import base from './payment_schema';
// Additive tables for callback ingestion; the frozen payment schema is imported unchanged.
export default defineSchema({
    ...base.tables,
    callbackIngress: defineTable({ tokenHash: v.string() }).index('token', ['tokenHash']),
    callbackParked: defineTable({ account: v.string(), eventId: v.string(), type: v.string(), digest: v.string(), at: v.number() }).index('key', ['account', 'eventId']),
    callbackAlerts: defineTable({ kind: v.string(), account: v.string(), count: v.number(), firstAt: v.number(), lastAt: v.number(), lastEventId: v.string() }).index('key', ['kind', 'account']),
    callbackRetries: defineTable({ incoming: v.id('payIncoming'), attempts: v.number(), nextAt: v.number(), code: v.string() }).index('incoming', ['incoming']),
});
