import { describe, expect, it } from "vitest";
import { RemoldClient, RemoldError } from "./client.js";

describe("RemoldClient", () => {
  it("posts proposals with bearer auth", async () => {
    let request: Request | undefined;
    const client = new RemoldClient({ url: "https://remold.convex.site", key: "rm_key", fetch: async (input, init) => { request = new Request(input, init); return Response.json({ suggestion: { id: "s" } }, { status: 201 }); } });
    await client.propose({ action: "update", record: "brisk-ember-oyster", values: { stage: "Won" }, reason: "qualified" });
    expect(request?.url).toBe("https://remold.convex.site/api/v1/suggestions");
    expect(request?.headers.get("authorization")).toBe("Bearer rm_key");
    expect(await request?.json()).toEqual({ action: "update", record: "brisk-ember-oyster", values: { stage: "Won" }, reason: "qualified" });
  });
  it("throws REST errors with their code", async () => {
    const client = new RemoldClient({ url: "https://remold.convex.site", key: "rm_key", fetch: async () => Response.json({ error: { code: "FORBIDDEN", message: "No grant" } }, { status: 403 }) });
    await expect(client.change({ action: "delete", record: "x", reason: "x" })).rejects.toMatchObject<Partial<RemoldError>>({ code: "FORBIDDEN", message: "No grant" });
  });
});
