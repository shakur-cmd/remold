import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import h0 from './h0_schema';

export default defineSchema({
  ...h0.tables,
  tasks: defineTable({
    org: v.id('orgs'), title: v.string(), assignee: v.id('actors'), createdBy: v.id('actors'),
    binding: v.id('bindings'), dependsOn: v.array(v.id('tasks')),
    status: v.union(...['blocked', 'ready', 'running', 'done', 'failed', 'paused', 'unknown'].map(v.literal)),
    generation: v.number(), occurrence: v.number(), attempts: v.number(), maxAttempts: v.number(),
    intervalMs: v.optional(v.number()), remaining: v.number(),
    operation: v.optional(v.id('operations')), artifact: v.optional(v.string()),
    fault: v.union(v.literal('none'), v.literal('retryOnce'), v.literal('loseResponse'), v.literal('holdBeforePermit')),
    heldBeforePermit: v.optional(v.boolean()), holdReleased: v.optional(v.boolean()),
  }).index('org', ['org']).index('assignee', ['org', 'assignee']),
  reports: defineTable({ org: v.id('orgs'), actor: v.id('actors'), manager: v.id('actors') }).index('actor', ['actor']),
  stubEffects: defineTable({ operation: v.id('operations'), key: v.string(), artifact: v.string() }).index('operation', ['operation']),
});
