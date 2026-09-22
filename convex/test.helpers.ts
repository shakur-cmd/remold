import { api } from "./_generated/api";
import { makeTest } from "./test.setup";

export async function userAndOrg(name = "A") {
  const t = makeTest();
  const identity = { tokenIdentifier: `clerk|${name}`, name };
  const client = t.withIdentity(identity);
  await client.mutation(api.users.store, {});
  const orgId = await client.mutation(api.orgs.create, { name: `${name} Org` });
  const objects = await client.query(api.objects.list, { orgId });
  return { t, client, orgId, objects };
}

export async function objectFields(client: any, orgId: any, key: string) {
  const objects = await client.query(api.objects.list, { orgId });
  const object = objects.find((item: any) => item.key === key);
  const detail = await client.query(api.objects.get, { orgId, objectId: object._id });
  return { object, fields: Object.fromEntries(detail.fields.map((field: any) => [field.key, field])) };
}

export { api };
