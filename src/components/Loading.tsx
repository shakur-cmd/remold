import { Skeleton } from "@/components/ui/skeleton";

// `page` is for the moments before the app shell exists (sign-in, first load).
export function Loading({ page = false }: { page?: boolean }) {
  if (page)
    return (
      <div className="flex min-h-dvh items-center justify-center" role="status" aria-label="Loading">
        <span className="animate-pulse text-[15px] font-semibold tracking-tight text-muted-foreground">Remold</span>
      </div>
    );
  return (
    <div className="grid max-w-2xl gap-3" role="status" aria-label="Loading">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-9" />
      <Skeleton className="h-9" />
      <Skeleton className="h-9 w-2/3" />
    </div>
  );
}
