import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const values = v.record(v.string(), v.union(v.string(), v.number()));
export default defineSchema({
  slotRecords: defineTable({ orgId: v.string(), objectKey: v.string(), sourceId: v.number(), values,
    n0: v.number(), s0: v.string() })
    .index("score", ["orgId", "objectKey", "n0"])
    .index("stage", ["orgId", "objectKey", "s0"])
    .index("source", ["orgId", "objectKey", "sourceId"]),
  valueRecords: defineTable({ orgId: v.string(), objectKey: v.string(), sourceId: v.number(), values })
    .index("source", ["orgId", "objectKey", "sourceId"]),
  recordValues: defineTable({ orgId: v.string(), objectKey: v.string(), fieldId: v.string(),
    value: v.union(v.number(), v.string()), recordId: v.id("valueRecords"), recordCreatedTime: v.number() })
    .index("value", ["orgId", "objectKey", "fieldId", "value", "recordCreatedTime", "recordId"])
    .index("record", ["orgId", "recordId"]),
});
