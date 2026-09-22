export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground" role="status">
      {label}
    </div>
  );
}
