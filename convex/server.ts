import { internalMutationGeneric, internalQueryGeneric } from "convex/server";
import type { DataModelFromSchemaDefinition, MutationBuilder, QueryBuilder } from "convex/server";
import schema from "./schema";
export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
export const internalMutation = internalMutationGeneric as MutationBuilder<DataModel, "internal">;
export const internalQuery = internalQueryGeneric as QueryBuilder<DataModel, "internal">;
