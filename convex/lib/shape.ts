import { v, type ValidatorJSON } from "convex/values";
import { internalQuery } from "../_generated/server";

// Checks a request body against a function's own argument validator before the
// call. Convex logs the whole argument object when its validator refuses one, and
// those arguments include the caller's key hash and anything a client forwarded.
type Json = ValidatorJSON | { type: "id"; tableName: string };
type Ids = { table: string; id: string }[];
function conforms(shape: Json, value: unknown, ids: Ids): boolean {
  switch (shape.type) {
    case "any": return true;
    case "null": return value === null;
    case "string": return typeof value === "string";
    case "number": return typeof value === "number";
    case "boolean": return typeof value === "boolean";
    case "bigint": case "bytes": case "commitTs": return false;
    // Table membership needs the database; collect IDs for idsBelong.
    case "id": if (typeof value !== "string" || value.length > 128) return false; ids.push({ table: shape.tableName, id: value }); return true;
    case "literal": return value === shape.value;
    case "array": return Array.isArray(value) && value.every(item => conforms(shape.value, item, ids));
    case "union": return shape.value.some(option => { const found: Ids = []; if (!conforms(option, value, found)) return false; ids.push(...found); return true; });
    case "record": return !!value && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([key, item]) => conforms(shape.keys as Json, key, ids) && conforms(shape.values.fieldType as Json, item, ids));
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const fields = shape.value, record = value as Record<string, unknown>;
      // Object.hasOwn: `in` also sees Object.prototype, so a key named constructor or toString would pass.
      if (Object.keys(record).some(key => !Object.hasOwn(fields, key))) return false;
      return Object.entries(fields).every(([key, field]) => record[key] === undefined ? field.optional : conforms(field.fieldType as Json, record[key], ids));
    }
  }
  return false;
}
// Returns the IDs to check with idsBelong, or null when the shape is wrong.
export function argumentsConform(fn: unknown, args: unknown): Ids | null {
  const exported = (fn as { exportArgs?: () => string } | undefined)?.exportArgs;
  if (!exported) return null;
  const ids: Ids = [];
  return conforms(JSON.parse(exported()) as Json, args, ids) ? ids : null;
}
export const idsBelong = internalQuery({ args: { ids: v.array(v.object({ table: v.string(), id: v.string() })) }, handler: async (ctx, args) => args.ids.every(({ table, id }) => ctx.db.normalizeId(table as never, id) !== null) });
