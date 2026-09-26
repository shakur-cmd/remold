import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
export const item = v.object({ id:v.string(), from:v.string(), text:v.string() });
const traversal = v.object({ id:v.string(), from:v.string(), receipts:v.array(v.string()), items:v.array(item) });
export default defineSchema({
  mailboxes: defineTable({ label:v.string(), cursor:v.string(), paused:v.boolean(), contacts:v.array(v.object({address:v.string(),contact:v.string()})), pending:v.union(v.null(),traversal), last:v.union(v.null(),v.object({id:v.string(),from:v.string(),receipts:v.array(v.string())})) }),
  messages: defineTable({ mailbox:v.id('mailboxes'), providerId:v.string(), from:v.string(), text:v.string(), contact:v.union(v.null(),v.string()) }).index('by_mailbox_id',['mailbox','providerId']),
});
