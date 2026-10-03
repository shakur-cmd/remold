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
  it("reads a campaign report, previews an email for one person and marks a reply", async () => {
    const requests: Request[] = [];
    const client = new RemoldClient({ url: "https://remold.convex.site/", key: "rm_key", fetch: async (input, init) => { requests.push(new Request(input, init)); return Response.json({}); } });
    await client.campaignReport("calm-river-fox");
    await client.emailPreview({ idOrRef: "bold-sun-owl", person: "ava ref" });
    await client.markReplied("send/1");
    expect(requests.map((r) => [r.method, r.url])).toEqual([["GET", "https://remold.convex.site/api/v1/campaigns/calm-river-fox/report"], ["GET", "https://remold.convex.site/api/v1/emails/bold-sun-owl/preview?person=ava+ref"], ["POST", "https://remold.convex.site/api/v1/sends/send%2F1/replied"]]);
  });
  it("throws REST errors with their code", async () => {
    const client = new RemoldClient({ url: "https://remold.convex.site", key: "rm_key", fetch: async () => Response.json({ error: { code: "FORBIDDEN", message: "No grant" } }, { status: 403 }) });
    await expect(client.change({ action: "delete", record: "x", reason: "x" })).rejects.toMatchObject<Partial<RemoldError>>({ code: "FORBIDDEN", message: "No grant" });
  });
});
