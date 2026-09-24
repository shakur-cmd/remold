import { Migrations } from "@convex-dev/migrations";
import { components } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";

const migrations = new Migrations(components.migrations, { internalMutation });
export const markRecords = migrations.define({
  table: "records",
  batchSize: 100,
  migrateOne: async (ctx, record) => {
    const org = await ctx.db.get(record.orgId);
    if (record.title === "Migration fixture 0400" && !org?.flags?.migrationResume) throw new Error("REHEARSAL_INTERRUPTED_400");
    if (record.migrationRevision === undefined) await ctx.db.patch(record._id, { migrationRevision: 1 });
  },
});
export const status = internalQuery({ args: {}, handler: ctx => migrations.getStatus(ctx, { migrations: ["migrationBackfill:markRecords"] }) });
