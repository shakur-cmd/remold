export function authReturnTarget(value: unknown, origin: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value || /[\\\u0000-\u0020]/.test(value)) return "/";
  if (!value.startsWith("/") && !value.startsWith(`${origin}/`)) return "/";
  try {
    const target = new URL(value, origin);
    if (target.origin !== origin || target.username || target.password || ["/callback", "/login"].includes(target.pathname)) return "/";
    return target.pathname + target.search + target.hash;
  } catch {
    return "/";
  }
}
