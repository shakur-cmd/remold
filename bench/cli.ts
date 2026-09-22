import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
export function deployment() {
  const fileEnv = Object.assign({}, ...[".env", ".env.local"].map(path => existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {})) as Record<string, string>;
  if (["CONVEX_DEPLOY_KEY", "CONVEX_SELF_HOSTED_URL", "CONVEX_SELF_HOSTED_ADMIN_KEY"].some(key => process.env[key] || fileEnv[key])) {
    throw new Error("Remove deployment-key and self-host overrides; the spike uses your logged-in Cloud dev deployment only.");
  }
  const value = process.env.CONVEX_DEPLOYMENT ?? fileEnv.CONVEX_DEPLOYMENT;
  if (!value?.startsWith("dev:")) throw new Error("This spike requires a dedicated Convex Cloud dev deployment, never production.");
  return value;
}
export function run<T>(name: string, args: object): T {
  return JSON.parse(execFileSync("pnpm", ["exec", "convex", "run", name, JSON.stringify(args)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })) as T;
}
export type Option = "slots" | "values";
export const scope = (option: Option) => ({ option, orgId: "remold-benchmark", objectKey: "customJob" });
