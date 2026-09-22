import { describe, expect, it } from "vitest";
import { api, userAndOrg } from "./test.helpers";
import { makeTest } from "./test.setup";

describe("identity", () => {
  it("rejects unauthenticated membership calls", async () => {
    const t = makeTest();
    await expect(t.query(api.orgs.get, { orgId: "00000000000000000000000000000orgs" as any })).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
  });
  it("creates one user on repeated store and seeds exact standard objects", async () => {
    const { client, orgId, objects } = await userAndOrg();
    await client.mutation(api.users.store, {});
    expect((await client.query(api.orgs.members, { orgId })).length).toBe(1);
    expect(objects.map((object) => object.key)).toEqual(["company", "person", "opportunity", "project", "task", "note", "campaign"]);
    const person = await client.query(api.objects.get, { orgId, objectId: objects.find((object) => object.key === "person")!._id });
    expect(person.fields.map((field) => field.key)).toEqual(["name", "email", "phone", "title", "company"]);
  });
});
