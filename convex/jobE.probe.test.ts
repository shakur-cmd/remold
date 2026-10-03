import { expect, it } from "vitest";
import { agentFor, api, objectFields, rest, userAndOrg } from "./test.helpers";

const DAY = 86400000;

it("P-F16: REST Today matches the app selection and order with real tasks and quiet deals", async () => {
  const { client, orgId, t } = await userAndOrg(), task = await objectFields(client, orgId, "task"), deal = await objectFields(client, orgId, "opportunity"), a = await agentFor(client, orgId, { name: "agent" });
  const now = Date.now(), today = Math.floor(now / DAY) * DAY;
  for (const [title, due, done] of [["Overdue", today - 3 * DAY, false], ["Today", today, false], ["Soon", today + 5 * DAY, false], ["Far", today + 30 * DAY, false], ["Done", today - DAY, true]] as const)
    await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: title, [task.fields.dueDate._id]: due, [task.fields.done._id]: done } });
  const quietId = (await client.mutation(api.records.create, { orgId, objectId: deal.object._id, values: { [deal.fields.name._id]: "Quiet", [deal.fields.stage._id]: "proposal" } })).recordId;
  await client.mutation(api.records.create, { orgId, objectId: deal.object._id, values: { [deal.fields.name._id]: "Fresh", [deal.fields.stage._id]: "proposal" } });
  await t.run(ctx => ctx.db.patch(quietId, { updatedAt: now - 20 * DAY }));
  const app = await client.query(api.today.get, { orgId, today });
  const result = (await rest(t, a.key)("GET", "/api/v1/today")).json;
  expect(Object.keys(result).sort()).toEqual(["quiet", "tasks"]);
  expect(result.tasks.map((r: any) => r.title)).toEqual(["Overdue", "Today", "Soon"]);
  expect(result.tasks.map((r: any) => r.id)).toEqual(app.tasks.map((r: any) => r._id));
  expect(result.quiet.map((r: any) => r.id)).toEqual(app.quiet.map((r: any) => r._id));
  expect(result.quiet.map((r: any) => r.title)).toEqual(["Quiet"]);
  expect(Object.keys(result.tasks[0]).sort()).toEqual(["createdAt", "id", "object", "ref", "title", "updatedAt", "values"]);
});

it("P-F11: existing live all-day and instant values across 1970-2200 still write and read; range queries still work", async () => {
  const { client, orgId, t } = await userAndOrg(), task = await objectFields(client, orgId, "task"), deal = await objectFields(client, orgId, "opportunity");
  const a = await agentFor(client, orgId, { name: "w", grants: [{ action: "create", objectKey: "task" }, { action: "create", objectKey: "opportunity" }] }), call = rest(t, a.key);
  for (const dueDate of [0, Date.UTC(1950, 5, 1), Date.UTC(2200, 11, 31), 0.5, Date.UTC(1969, 11, 31, 23, 59, 59, 999)]) {
    const r = await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: `t${dueDate}`, [task.fields.dueDate._id]: dueDate } });
    expect((await call("GET", `/api/v1/records/${r.recordId}`)).status).toBe(200);
  }
  for (const closeDate of [0, Date.UTC(1950, 5, 1), Date.UTC(2200, 11, 31)]) await client.mutation(api.records.create, { orgId, objectId: deal.object._id, values: { [deal.fields.name._id]: `d${closeDate}`, [deal.fields.closeDate._id]: closeDate } });
  const listed = await call("GET", `/api/v1/records?object=opportunity&range[closeDate]=1940-01-01..2200-12-31`);
  expect(listed.status).toBe(200); expect(listed.json.records).toHaveLength(3);
  expect((await call("POST", "/api/v1/changes", { action: "create", object: "opportunity", values: { name: "Plain all-day", closeDate: "1970-01-01" }, reason: "t" })).status).toBe(200);
});

it("P-F13: /me shows only this agent's own live grants and nothing from other agents", async () => {
  const { client, orgId, t } = await userAndOrg(), c = await objectFields(client, orgId, "company");
  const a = await agentFor(client, orgId, { name: "a" }), b = await agentFor(client, orgId, { name: "b" });
  const secret = await client.mutation(api.records.create, { orgId, objectId: c.object._id, values: { [c.fields.name._id]: "Secret Co" } });
  const bGrant = await client.mutation(api.authority.grants.grant, { orgId, target: b.agentId, capability: "record.update", scope: { kind: "records", objectId: c.object._id, records: [secret.recordId], fields: [c.fields.city._id] }, mode: "direct", delegate: false, expiresAt: Date.now() + 60000 });
  const expired = await client.mutation(api.authority.grants.grant, { orgId, target: a.agentId, capability: "record.update", scope: { kind: "records", objectId: c.object._id, records: "all", fields: [c.fields.city._id] }, mode: "direct", delegate: false, expiresAt: Date.now() + 60000 });
  await client.mutation(api.authority.grants.revoke, { orgId, id: expired });
  const me = (await rest(t, a.key)("GET", "/api/v1/me")).json, text = JSON.stringify(me);
  expect(me.agent.capabilities).toEqual([]);
  expect(text).not.toContain(bGrant); expect(text).not.toContain(expired); expect(text).not.toContain(secret.recordId); expect(text).not.toMatch(/keyHash|hash|secret/i);
});

it("P-F13: /objects hides fields hidden from the agent and their write modes", async () => {
  const { client, orgId, t } = await userAndOrg(), c = await objectFields(client, orgId, "company"), a = await agentFor(client, orgId, { name: "a", grants: [{ action: "update", objectKey: "company" }] });
  await t.run(ctx => ctx.db.patch(a.agentId, { hiddenFieldIds: [c.fields.city._id] }));
  const fields = (await rest(t, a.key)("GET", "/api/v1/objects")).json.find((o: any) => o.key === "company").fields;
  expect(fields.map((f: any) => f.key)).not.toContain("city");
  expect(fields.find((f: any) => f.key === "name").write).toEqual({ create: "propose", update: "direct" });
});

it("P-F3: fresh deletes still apply after a no-op update or a links value; a cleared value conflicts", async () => {
  const { client, orgId, t } = await userAndOrg(), c = await objectFields(client, orgId, "company"), p = await objectFields(client, orgId, "person"), a = await agentFor(client, orgId, { name: "agent" });
  const co = await client.mutation(api.records.create, { orgId, objectId: c.object._id, values: { [c.fields.name._id]: "Acme", [c.fields.city._id]: "Boston" } });
  const person = await client.mutation(api.records.create, { orgId, objectId: p.object._id, values: { [p.fields.name._id]: "Ada", [p.fields.company._id]: co.recordId } });
  const call = rest(t, a.key);
  const s1 = await call("POST", "/api/v1/suggestions", { action: "delete", record: person.recordId, reason: "r" });
  await client.mutation(api.records.update, { orgId, recordId: person.recordId, values: { [p.fields.name._id]: "Ada" } });
  expect((await client.mutation(api.suggestions.apply, { orgId, suggestionId: s1.json.suggestion.id })).status).toBe("applied");
  const s2 = await call("POST", "/api/v1/suggestions", { action: "delete", record: co.recordId, reason: "r" });
  await client.mutation(api.records.update, { orgId, recordId: co.recordId, values: { [c.fields.city._id]: null } });
  const r2 = await client.mutation(api.suggestions.apply, { orgId, suggestionId: s2.json.suggestion.id });
  expect(r2.status).toBe("conflicted"); expect(await t.run(ctx => ctx.db.get(co.recordId))).not.toBeNull();
});

it("P-F12: delete proposals and responses never show retired values", async () => {
  const { client, orgId, t } = await userAndOrg(), c = await objectFields(client, orgId, "company");
  const { fieldId } = await client.mutation(api.fields.create, { orgId, objectId: c.object._id, key: "oldValue", label: "Old", type: "text" });
  const r = await client.mutation(api.records.create, { orgId, objectId: c.object._id, values: { [c.fields.name._id]: "Old", [fieldId]: "RETAINED-SECRET" } });
  await client.mutation(api.fields.retire, { orgId, fieldId });
  const a = await agentFor(client, orgId, { name: "agent", grants: [{ action: "delete", objectKey: "company" }] }), call = rest(t, a.key);
  const s = await call("POST", "/api/v1/suggestions", { action: "delete", record: r.recordId, reason: "r" });
  expect(s.status).toBe(201); expect(JSON.stringify(s.json)).not.toContain("RETAINED-SECRET");
  const d = await call("POST", "/api/v1/changes", { action: "delete", record: r.recordId, reason: "r" });
  expect(d.status).toBe(200); expect(JSON.stringify(d.json)).not.toContain("RETAINED-SECRET");
});

it("P-F10: the same key on a different route or body is refused, and keys are per agent", async () => {
  const { client, orgId, t } = await userAndOrg(), a = await agentFor(client, orgId, { name: "a", role: "admin" }), b = await agentFor(client, orgId, { name: "b", role: "admin" });
  const ca = rest(t, a.key), cb = rest(t, b.key), h = { "idempotency-key": "k1" };
  const send = async (call: typeof ca, path: string, body: unknown) => { const r = await t.fetch(path, { method: "POST", headers: { authorization: `Bearer ${call === ca ? a.key : b.key}`, "content-type": "application/json", ...h }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  const first = await send(ca, "/api/v1/inbox", { text: "one" }); expect(first.status).toBe(201);
  expect((await send(ca, "/api/v1/inbox", { text: "two" })).json.error?.code).toBe("IDEMPOTENCY_MISMATCH");
  expect((await send(ca, "/api/v1/suggestions", { action: "create", object: "company", values: { name: "X" }, reason: "r" })).json.error?.code).toBe("IDEMPOTENCY_MISMATCH");
  expect((await send(cb, "/api/v1/inbox", { text: "one" })).status).toBe(201);
  expect(await t.run(ctx => ctx.db.query("agentInbox").collect())).toHaveLength(2);
});

it("P-F4: a rejected row in the middle of a batch leaves earlier and later good rows intact", async () => {
  const { client, orgId, t } = await userAndOrg(), d = await objectFields(client, orgId, "opportunity");
  const result = await client.mutation(api.csv.importRows, { orgId, objectId: d.object._id, columns: [d.fields.company._id, d.fields.name._id, d.fields.amount._id], rows: [["A Co", "One", "1"], ["Ghost", "Two", "bad"], ["B Co", "Three", "3"], ["A Co", "Four", "4"]], firstRow: 2, skipDuplicates: false, createMissing: true });
  expect(result).toMatchObject({ created: 3, skipped: 0 }); expect(result.errors).toHaveLength(1);
  const companies = (await t.run(ctx => ctx.db.query("records").collect())).filter((r: any) => r.objectId !== d.object._id).map((r: any) => r.title).sort();
  expect(companies).toEqual(["A Co", "B Co"]);
});
