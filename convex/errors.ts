import { ConvexError } from "convex/values";
import type { Value } from "convex/values";

export type ErrorCode = "AUTHORITY_MIGRATING" | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "VALIDATION" | "INVITE_EXPIRED" | "UNINDEXED_FIELD" | "UNSUPPORTED" | "SLOTS_EXHAUSTED";

export function fail(code: ErrorCode, message: string = code, extra: Record<string, Value> = {}): never {
  throw new ConvexError({ code, message, ...extra });
}
