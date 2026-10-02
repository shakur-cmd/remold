import { beforeAll, describe, expect, it } from "vitest";
import { api, agentFor, objectFields, rest, userAndOrg } from "./test.helpers";

async function noisyRecord() {
  const setup = await userAndOrg();
  const { client, orgId } = setup;
  const company = await objectFields(client, orgId, "company");
  const { recordId } = await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: "Noisy 0" } });
  for (let i = 1; i < 250; i += 1) await client.mutation(api.records.update, { orgId, recordId, values: { [company.fields.name._id]: `Noisy ${i}` } });
  return { ...setup, recordId, nameId: company.fields.name._id };
}

describe("history paging", () => {
  let noisy: Awaited<ReturnType<typeof noisyRecord>>;
  beforeAll(async () => { noisy = await noisyRecord(); }, 60_000);

  it("the app pages a record's 250 events down to its creation, newest first, with no duplicates or gaps", async () => {
    const { client, orgId, recordId, nameId } = noisy;
    const seen: any[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const page: any = await client.query(api.events.timeline, { orgId, recordId, paginationOpts: { numItems: 60, cursor } });
      seen.push(...page.page);
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(seen).toHaveLength(250);
    expect(new Set(seen.map((e) => e._id)).size).toBe(250);
    expect(seen.at(-1).action).toBe("create");
    expect(seen.map((e) => e.after[nameId])).toEqual(Array.from({ length: 250 }, (_, i) => `Noisy ${249 - i}`));
  });

  it("REST pages /records/:id/events with ?cursor= and nextCursor to the first event", async () => {
    const { t, client, orgId, recordId } = noisy;
    const agent = await agentFor(client, orgId, { name: "Reader" });
    const call = rest(t, agent.key);
    const first = await call("GET", `/api/v1/records/${recordId}`);
    expect(first.json.events).toHaveLength(20);
    expect(typeof first.json.nextCursor).toBe("string");
    const seen: any[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 30; guard += 1) {
      const page = await call("GET", `/api/v1/records/${recordId}/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(page.status).toBe(200);
      seen.push(...page.json.events);
      if (!page.json.nextCursor) break;
      cursor = page.json.nextCursor;
    }
    expect(seen).toHaveLength(250);
    expect(seen.map((e) => e.after.name)).toEqual(Array.from({ length: 250 }, (_, i) => `Noisy ${249 - i}`));
    expect(seen.at(-1).action).toBe("create");
    expect((await call("GET", `/api/v1/records/${recordId}/events?cursor=nonsense`)).status).toBe(400);
  });
});
