import { describe, expect, it } from "vitest";
import { authSessionOptions } from "./identity-session";

const staging = "client_01M3AAH302D3TVVDJN9SBNYARF";
describe("AuthKit session configuration", () => {
  it("allows persistent synthetic preview sessions only with the flag, staging client and owned preview host", () => {
    const config = { mode: "preview-local", clientId: staging, hostname: "pr-4-remold-i2-preview.shakur-949.workers.dev" };
    expect(authSessionOptions(config).devMode).toBe(true);
    for (const change of [{ mode: undefined }, { clientId: "client_production" }, { hostname: "app.remoldcrm.com" }, { hostname: "pr-4-remold-i2-preview.shakur-949.workers.dev.other.invalid" }, { hostname: "pr-4-unrelated.workers.dev" }]) {
      expect(authSessionOptions({ ...config, ...change }).devMode).toBe(false);
    }
  });
  it("preserves local development and leaves production on cookie sessions", () => {
    for (const hostname of ["localhost", "127.0.0.1"]) expect(authSessionOptions({ hostname, clientId: staging }).devMode).toBe(true);
    expect(authSessionOptions({ hostname: "app.remoldcrm.com", clientId: "client_production", apiHostname: "auth.remoldcrm.com" })).toEqual({ devMode: false, apiHostname: "auth.remoldcrm.com" });
  });
});
