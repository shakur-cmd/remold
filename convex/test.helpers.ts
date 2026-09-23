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

export async function agentFor(client: any, orgId: any, options: { name: string; role?: "admin" | "member"; grants?: { action: "create" | "update" | "delete"; objectKey: string }[] }) {
  return client.action(api.agents.create, { orgId, ...options });
}

export function rest(t: any, key: string) {
  return async (method: string, path: string, body?: unknown) => {
    const response = await t.fetch(path, { method, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() };
  };
}

export { api };
