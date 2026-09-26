import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export default defineSchema({
  objects: defineTable({ name: v.string() }),
});
