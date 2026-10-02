import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTest } from "./test.setup";

const adapterKey = "ra_" + "0".repeat(64);
const post = (t: any, name: string, key = adapterKey) => t.fetch(`/api/integrations/v1/${name}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: "{}" });

describe("payment and provider callbacks", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("answer 404 unless REMOLD_PAYMENT_CALLBACKS is 1", async () => {
    const t = makeTest();
    for (const value of ["", "0", "true"]) {
      vi.stubEnv("REMOLD_PAYMENT_CALLBACKS", value);
      for (const name of ["callback", "permit", "safety-receipt", "lookup"]) expect((await post(t, name)).status).toBe(404);
      expect((await post(t, "callback", "nonsense")).status).toBe(404);
    }
  });
  it("reach the adapter checks when REMOLD_PAYMENT_CALLBACKS is 1", async () => {
    const t = makeTest();
    vi.stubEnv("REMOLD_PAYMENT_CALLBACKS", "1");
    expect((await post(t, "callback", "nonsense")).status).toBe(401);
    const response = await post(t, "callback");
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION");
  });
});
