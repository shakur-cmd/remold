import { ConvexError } from "convex/values";

export function errorMessage(error: unknown): string {
  if (error instanceof ConvexError) {
    const data = error.data as { message?: string } | string;
    return typeof data === "string" ? data : (data.message ?? "Request failed");
  }
  return error instanceof Error ? error.message : "Something went wrong";
}
