import { ConvexError } from "convex/values";
import { toast } from "sonner";

export function errorMessage(error: unknown): string {
  if (error instanceof ConvexError) {
    const data = error.data as { message?: string } | string;
    return typeof data === "string" ? data : (data.message ?? "Request failed");
  }
  return error instanceof Error ? error.message : "Something went wrong";
}

// Runs a mutation from a click: a toast on success if asked, a toast with the
// reason on failure. Resolves true when the action succeeded.
export async function attempt(action: () => Promise<unknown>, success?: string): Promise<boolean> {
  try {
    await action();
    if (success) toast.success(success);
    return true;
  } catch (error) {
    toast.error(errorMessage(error));
    return false;
  }
}
