import { v } from "convex/values";
import { makeFunctionReference, internalActionGeneric } from "convex/server";
import { internalQuery, internalMutation } from "./server";
import { values } from "./schema";

const option = v.union(v.literal("slots"), v.literal("values"));
const scope = { option, orgId: v.string(), objectKey: v.string() };
const query = v.union(v.literal("score"), v.literal("won"), v.literal("contacted"));

// Internal-only functions: the spike has no public endpoints or user data.
export const page = internalQuery({
  args: { ...scope, query, cursor: v.union(v.string(), v.null()), sampleId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const pagination = { numItems: 50, cursor: args.cursor };
    let indexRangeRequests = 0;
    const log = () => { if (args.sampleId) console.log(JSON.stringify({ marker: "REMOLD_BENCH", sampleId: args.sampleId, indexRangeRequests })); };
    if (args.option === "slots") {
      const table = ctx.db.query("slotRecords");
      const range = args.query === "score"
        ? table.withIndex("score", q => q.eq("orgId", args.orgId).eq("objectKey", args.objectKey))
        : table.withIndex("stage", q => q.eq("orgId", args.orgId).eq("objectKey", args.objectKey).eq("s0", args.query));
      indexRangeRequests++;
      const result = await range.order("desc").paginate(pagination);
      log();
      return result;
    }
    const field = args.query === "score" ? "score" : "stage";
    const table = ctx.db.query("recordValues");
    const range = args.query === "score"
      ? table.withIndex("value", q => q.eq("orgId", args.orgId).eq("objectKey", args.objectKey).eq("fieldId", field))
      : table.withIndex("value", q => q.eq("orgId", args.orgId).eq("objectKey", args.objectKey).eq("fieldId", field).eq("value", args.query));
    indexRangeRequests++;
    const result = await range.order("desc").paginate(pagination);
    const records = await Promise.all(result.page.map(async value => {
      indexRangeRequests++;
      const record = await ctx.db.get(value.recordId);
      if (!record || record.orgId !== args.orgId || record.objectKey !== args.objectKey) throw new Error("Invalid value-row reference");
      return record;
    }));
    log();
    return { ...result, page: records };
  },
});

export const seedBatch = internalMutation({
  args: { ...scope, rows: v.array(v.object({ sourceId: v.number(), values })) },
  handler: async (ctx, args) => {
    if (args.rows.length > 100) throw new Error("Seed batch limit is 100");
    const manifest = [];
    for (const row of args.rows) {
      if (typeof row.values.score !== "number" || typeof row.values.stage !== "string") throw new Error("Invalid benchmark fields");
      const common = { orgId: args.orgId, objectKey: args.objectKey, ...row };
      const table = args.option === "slots" ? "slotRecords" : "valueRecords";
      const existing = await ctx.db.query(table).withIndex("source", q => q.eq("orgId", args.orgId).eq("objectKey", args.objectKey).eq("sourceId", row.sourceId)).unique();
      if (existing) {
        if (Object.keys(existing.values).length !== Object.keys(row.values).length || Object.entries(row.values).some(([key, value]) => existing.values[key] !== value)) throw new Error("Seed source ID already has different values");
        manifest.push({ _id: existing._id, _creationTime: existing._creationTime, sourceId: row.sourceId });
        continue;
      }
      if (args.option === "slots") {
        const id = await ctx.db.insert("slotRecords", { ...common, n0: row.values.score, s0: row.values.stage });
        const doc = (await ctx.db.get(id))!;
        manifest.push({ _id: id, _creationTime: doc._creationTime, sourceId: row.sourceId });
      } else {
        const id = await ctx.db.insert("valueRecords", common);
        const doc = (await ctx.db.get(id))!;
        for (const [fieldId, value] of Object.entries(row.values)) await ctx.db.insert("recordValues", {
          orgId: args.orgId, objectKey: args.objectKey, fieldId, value, recordId: id, recordCreatedTime: doc._creationTime,
        });
        manifest.push({ _id: id, _creationTime: doc._creationTime, sourceId: row.sourceId });
      }
    }
    return manifest;
  },
});

export const inventory = internalQuery({
  args: { ...scope, cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const table = args.option === "slots" ? "slotRecords" : "valueRecords";
    return await ctx.db.query(table).withIndex("source", q => q.eq("orgId", args.orgId).eq("objectKey", args.objectKey))
      .paginate({ numItems: 100, cursor: args.cursor });
  },
});

export const sample = internalActionGeneric({
  args: { ...scope, query, cursor: v.union(v.string(), v.null()), sampleId: v.string() },
  handler: async (ctx, { sampleId, ...args }) => {
    const start = Date.now();
    const result = await ctx.runQuery(makeFunctionReference<"query">("bench:page"), { ...args, sampleId });
    // Includes server dispatch; never label this engine execution time or read telemetry.
    const serverActionElapsedMs = Date.now() - start;
    return { ...result, serverActionElapsedMs, sampleId };
  },
});

// Remove only the synthetic recovery row so the independent verifier can repeat
// the benchmark on the same 50,000-record deployment without resetting it.
export const removeRecovery = internalMutation({
  args: scope,
  handler: async (ctx, args) => {
    if (args.orgId !== "remold-benchmark" || args.objectKey !== "customJob") throw new Error("Not the benchmark scope");
    const table = args.option === "slots" ? "slotRecords" : "valueRecords";
    const record = await ctx.db.query(table).withIndex("source", q => q.eq("orgId", args.orgId).eq("objectKey", args.objectKey).eq("sourceId", 50_001)).unique();
    if (!record) return;
    if (record.values.score !== 10_000 || record.values.name !== "Fictional job 1") throw new Error("Not the recovery fixture");
    if (table === "valueRecords") {
      const values = await ctx.db.query("recordValues").withIndex("record", q => q.eq("orgId", args.orgId).eq("recordId", record._id as import("convex/values").GenericId<"valueRecords">)).take(13);
      if (values.length !== 12) throw new Error("Unexpected recovery field count");
      for (const value of values) await ctx.db.delete(value._id);
    }
    await ctx.db.delete(record._id);
  },
});
