import { afterEach, describe, expect, it, vi } from "vitest";
import { anyApi } from "convex/server";
import schema from "./schema";
import { api, objectFields, userAndOrg } from "./test.helpers";

// Replaces every id with the order it first appears in, so two exports compare by shape and links, not by id.
function modIds(data: any) {
  const seen = new Map<string, string>();
  const ids = new Set<string>([...data.objects, ...data.fields, ...data.records, ...data.events].map((row: any) => row.id));
  for (const event of data.events) ids.add(event.record);
  const walk = (value: any): any => typeof value === "string" ? (ids.has(value) ? (seen.get(value) ?? (seen.set(value, `#${seen.size}`), `#${seen.size - 1}`)) : value) : Array.isArray(value) ? value.map(walk) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)])) : value;
  const { exportedAt, ...rest } = data;
  return walk(rest);
}

async function filled(name: string) {
  const f = await userAndOrg(name), { client, orgId } = f;
  const company = await objectFields(client, orgId, "company"), person = await objectFields(client, orgId, "person"), task = await objectFields(client, orgId, "task");
  const vendorId = await client.mutation(api.objects.create, { orgId, key: "vendor", label: "Vendor", labelPlural: "Vendors" });
  const { fieldId: rating } = await client.mutation(api.fields.create, { orgId, objectId: vendorId, key: "rating", label: "Rating", type: "number" });
  const { fieldId: supplier } = await client.mutation(api.fields.create, { orgId, objectId: vendorId, key: "supplier", label: "Supplier", type: "lookup", targetObjectId: company.object._id });
  await client.mutation(api.fields.update, { orgId, fieldId: company.fields.city._id, label: "Town" });
  await client.mutation(api.fields.retire, { orgId, fieldId: company.fields.street._id });
  const acme = (await client.mutation(api.records.create, { orgId, objectId: company.object._id, values: { [company.fields.name._id]: `${name} Acme`, [company.fields.city._id]: "Leeds" } })).recordId;
  const ann = (await client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: `${name} Ann`, [person.fields.company._id]: acme } })).recordId;
  const gone = (await client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: `${name} Gone` } })).recordId;
  await client.mutation(api.records.update, { orgId, recordId: ann, values: { [person.fields.email._id]: "ann@example.invalid" } });
  await client.mutation(api.records.remove, { orgId, recordId: gone });
  const t2 = (await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: `${name} second`, [task.fields.dueDate._id]: Date.UTC(2026, 9, 2, 14, 30) } })).recordId;
  await client.mutation(api.records.create, { orgId, objectId: task.object._id, values: { [task.fields.title._id]: `${name} first`, [task.fields.blockedBy._id]: [t2], [task.fields.about._id]: ann, [task.fields.done._id]: false } });
  await client.mutation(api.records.create, { orgId, objectId: vendorId, values: { [(await objectFields(client, orgId, "vendor")).fields.name._id]: `${name} Vendor`, [rating]: 4, [supplier]: acme } });
  return { ...f, acme, ann, t2, person, task };
}

const ownerOnly = { data: { code: "FORBIDDEN" } };
afterEach(() => { vi.useRealTimers(); });

describe("full workspace export", () => {
  it("writes definitions, records keyed by field key, links by record id and the whole history", async () => {
    const a = await filled("A");
    const data: any = await a.client.action(api.workspace.exportAll, { orgId: a.orgId });
    expect(data).toMatchObject({ format: "remold.workspace", version: 1, workspace: { name: "A Org" } });
    expect(data.objects.map((o: any) => o.key)).toContain("vendor");
    expect(data.fields).toContainEqual(expect.objectContaining({ key: "city", label: "Town" }));
    expect(data.fields).toContainEqual(expect.objectContaining({ key: "street", retired: true }));
    const ann = data.records.find((r: any) => r.id === a.ann);
    expect(ann.values).toEqual({ name: "A Ann", company: a.acme, email: "ann@example.invalid" });
    const first = data.records.find((r: any) => r.values.title === "A first");
    expect(first.values).toMatchObject({ blockedBy: [a.t2], about: a.ann, done: false });
    expect(data.events.map((e: any) => e.action)).toEqual(["create", "create", "create", "update", "delete", "create", "create", "create"]);
    expect(data.events.find((e: any) => e.action === "update")).toMatchObject({ record: a.ann, before: { email: null }, after: { email: "ann@example.invalid" } });
    expect(data.events.find((e: any) => e.action === "delete").before).toEqual({ name: "A Gone" });
    expect(data.events.every((e: any) => typeof e.at === "number")).toBe(true);
  });

  it("contains nothing from another workspace and is refused to anyone but an unrestricted owner", async () => {
    const a = await filled("A");
    const b = a.t.withIdentity({ tokenIdentifier: "clerk|B", name: "B" });
    await b.mutation(api.users.store, {});
    const orgB = await b.mutation(api.orgs.create, { name: "B Org" });
    const company = await objectFields(b, orgB, "company");
    const secret = (await b.mutation(api.records.create, { orgId: orgB, objectId: company.object._id, values: { [company.fields.name._id]: "B secret" } })).recordId;
    const text = JSON.stringify(await a.client.action(api.workspace.exportAll, { orgId: a.orgId }));
    expect(text).not.toContain("B secret");
    expect(text).not.toContain(secret);
    expect(text).not.toContain(orgB);
    expect(text).not.toContain(company.object._id);
    await expect(b.action(api.workspace.exportAll, { orgId: a.orgId })).rejects.toMatchObject(ownerOnly);
    const invite = await a.client.mutation(api.invites.create, { orgId: a.orgId, role: "admin" });
    await b.mutation(api.invites.accept, { token: invite.token });
    await expect(b.action(api.workspace.exportAll, { orgId: a.orgId })).rejects.toMatchObject(ownerOnly);
  });

  it("Export is refused to an owner with hidden fields or record scopes", async () => {
    const a = await filled("A");
    const memberId = await a.t.run(async (ctx: any) => (await ctx.db.query("members").collect())[0]._id);
    const company = await objectFields(a.client, a.orgId, "company");
    await a.client.mutation(anyApi["authority/policies"].setMember, { orgId: a.orgId, memberId, hiddenFieldIds: [company.fields.city._id] });
    await expect(a.client.action(api.workspace.exportAll, { orgId: a.orgId })).rejects.toMatchObject(ownerOnly);
    await expect(a.client.action(api.workspace.remove, { orgId: a.orgId, confirmName: "A Org" })).rejects.toMatchObject(ownerOnly);
  });
});

describe("workspace import", () => {
  it("restores an export into a fresh workspace with new ids, links intact, and re-exports the same", async () => {
    const a = await filled("A");
    const original: any = await a.client.action(api.workspace.exportAll, { orgId: a.orgId });
    const fresh = await a.client.mutation(api.orgs.create, { name: "A Org" });
    await a.client.action(api.workspace.importAll, { orgId: fresh, data: original });
    const again: any = await a.client.action(api.workspace.exportAll, { orgId: fresh });
    expect(again.records.map((r: any) => r.id)).not.toContain(a.ann);
    expect(modIds(again)).toEqual(modIds(original));
    // The restored records work through the app: the lookup resolves and history shows the update.
    const person = await objectFields(a.client, fresh, "person");
    const ann = again.records.find((r: any) => r.values.name === "A Ann");
    const read: any = await a.client.query(api.records.get, { orgId: fresh, recordId: ann.id });
    expect(read.record.values[person.fields.company._id]).toBe(again.records.find((r: any) => r.values.name === "A Acme").id);
    expect((await a.client.query(api.events.forRecord, { orgId: fresh, recordId: ann.id })).map((e: any) => e.action)).toEqual(["update", "create"]);
  });

  it("refuses a workspace that already has records, and refuses non-owners", async () => {
    const a = await filled("A");
    const data: any = await a.client.action(api.workspace.exportAll, { orgId: a.orgId });
    await expect(a.client.action(api.workspace.importAll, { orgId: a.orgId, data })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
    const b = a.t.withIdentity({ tokenIdentifier: "clerk|B", name: "B" });
    await b.mutation(api.users.store, {});
    const fresh = await a.client.mutation(api.orgs.create, { name: "Fresh" });
    await expect(b.action(api.workspace.importAll, { orgId: fresh, data })).rejects.toMatchObject(ownerOnly);
    await expect(a.client.action(api.workspace.importAll, { orgId: fresh, data: { ...data, version: 99 } })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
    // A member's mask names field ids that import would replace.
    const masked = await a.t.run(async (ctx: any) => { const field = (await ctx.db.query("fields").collect()).find((f: any) => f.orgId === fresh); return ctx.db.insert("members", { orgId: fresh, userId: await ctx.db.insert("users", { tokenIdentifier: "clerk|C", name: "C" }), role: "member", hiddenFieldIds: [field._id] }); });
    await expect(a.client.action(api.workspace.importAll, { orgId: fresh, data })).rejects.toMatchObject({ data: { code: "VALIDATION", message: expect.stringMatching(/restrictions/) } });
    await a.t.run(async (ctx: any) => ctx.db.delete(masked));
    await a.t.run(async (ctx: any) => ctx.db.patch(fresh, { flags: { readonly: true } }));
    await expect(a.client.action(api.workspace.importAll, { orgId: fresh, data })).rejects.toMatchObject({ data: { code: "FORBIDDEN", message: "Workspace is read only" } });
  });
});

// Every table whose rows carry an orgId, from the schema itself, so a new per-workspace table must be covered.
const orgTables = Object.entries(schema.tables).filter(([, table]: any) => "orgId" in table.validator.fields).map(([name]) => name);

async function seedEverywhere(t: any, orgId: any) {
  await t.run(async (ctx: any) => {
    const member = (await ctx.db.query("members").collect()).find((m: any) => m.orgId === orgId);
    const object = (await ctx.db.query("objects").collect()).find((o: any) => o.orgId === orgId);
    const agentId = await ctx.db.insert("agents", { orgId, name: "bot", role: "member", createdBy: member.userId, keyHash: `h${orgId}`, keyPrefix: "rm_", grants: [] });
    const actor = { kind: "user", id: member.userId };
    await ctx.db.insert("capabilityGrants", { orgId, agentId, grantor: actor, grantorEpoch: 0, capability: "read", scope: { kind: "records", objectId: object._id, records: "all", fields: [] }, mode: "propose", delegate: false, expiresAt: Date.now() + 1e9 });
    await ctx.db.insert("invites", { orgId, token: `tok${orgId}`, role: "member", createdBy: member.userId, expiresAt: Date.now() + 1e9 });
    await ctx.db.insert("authorityAudit", { orgId, actor, action: "test", targetId: "x" });
    await ctx.db.insert("opsEvents", { orgId, actor: { kind: "operator", id: "internal-admin" }, action: "featureFlagChanged", flag: "f", before: false, after: true, reason: "test" });
    const suggestion = await ctx.db.insert("suggestions", { orgId, agentId, status: "pending", change: { action: "create", objectId: object._id, values: {} }, before: {}, reason: "r" });
    await ctx.db.insert("agentInbox", { orgId, text: "hi", source: "test", from: { kind: "agent", id: agentId }, status: "pending", suggestionId: suggestion });
    const secret = await ctx.db.insert("secretReferences", { orgId, provider: "p", environment: "test", account: `a${orgId}`, handle: "h", version: 1, active: true });
    const connectionId = await ctx.db.insert("integrationConnections", { orgId, provider: "p", environment: "test", account: `a${orgId}`, secretReferenceId: secret, credentialHash: `c${orgId}`, connected: true, healthy: true, version: 1 });
    const bindingId = await ctx.db.insert("integrationBindings", { orgId, connectionId, provider: "p", environment: "test", account: `a${orgId}`, kind: "k", externalId: "e", connected: true });
    await ctx.db.insert("integrationIntents", { orgId, connectionId, logical: "l", kind: "k", desired: "present", cleanupRequired: false });
    await ctx.db.insert("integrationCallbacks", { orgId, bindingId, eventId: "ev", digest: "d", receivedAt: 1 });
    await ctx.db.insert("integrationObservations", { orgId, bindingId, version: 1, state: "s", observedAt: 1 });
    const cursorId = await ctx.db.insert("integrationCursors", { orgId, connectionId, resource: "r", checkpoint: 0, traversal: "t", nextPage: 0, complete: false });
    await ctx.db.insert("integrationPages", { cursorId, traversal: "t", page: 0, digest: "d" });
    const lookupId = await ctx.db.insert("integrationLookups", { orgId, connectionId, cursorId, resource: "r", traversal: "t", pageCount: 0, digest: "d", completedAt: 1 });
    const targetId = await ctx.db.insert("safetyTargets", { orgId, bindingId, documentRef: "doc", providerRef: "pr", kind: "payment", currency: "usd", paidMinor: 0, refundedMinor: 0, pendingRefundMinor: 0, cancelled: false, generation: 0, startedAt: 1, complete: false, providerPendingMinor: 0, lookupId });
    await ctx.db.insert("integrationReceipts", { orgId, targetId, provider: "p", environment: "test", account: "a", kind: "refund", receipt: { receiptId: `r${orgId}`, sourceRef: "s", status: "pending", amountMinor: 1, currency: "usd" } });
    await ctx.db.insert("consent", { orgId, recipient: "x@example.invalid", channel: "email", purpose: "p", suppressed: false, source: "s", version: 1, at: 1 });
    await ctx.db.insert("usageBudgets", { key: orgId, orgId, cap: 0, maxConcurrent: 0, maxPerRun: 0, maxSteps: 0, maxRecipients: 0, reserved: 0, active: 0, spent: 0, missingUsage: false, missingUsageCount: 0 });
    const operationId = await ctx.db.insert("integrationOps", { orgId, actor, owner: actor, author: actor, actorEpoch: 0, capability: "marketing.send", logical: "l", bindingId, payload: { content: "", audience: [], audienceVersion: 0, destination: "", schedule: 0, amountMinor: 0, currency: "usd", workflowVersion: 0 }, version: 1, state: "proposed", reservationUnits: 0, reserved: 0, usage: 0, usageMissing: false, step: 0, maxSteps: 1, fence: 0, leaseUntil: 0, permitUntil: 0, permitUsed: false, attempts: 0, released: false, overrun: false, late: false, consumedPermits: [], receipts: [] });
    await ctx.db.insert("integrationEvents", { orgId, operationId, actor, name: "n", at: 1 });
  });
}

async function counts(t: any, orgId: string): Promise<Record<string, number>> {
  return t.run(async (ctx: any) => {
    const out: Record<string, number> = {};
    for (const name of Object.keys(schema.tables)) {
      const rows = await ctx.db.query(name).collect();
      out[name] = rows.filter((row: any) => row.orgId === orgId || row._id === orgId).length;
    }
    out.integrationPagesAll = (await ctx.db.query("integrationPages").collect()).length;
    out.usersAll = (await ctx.db.query("users").collect()).length;
    return out;
  });
}

describe("workspace deletion", () => {
  it("needs the owner and the exact workspace name, and hands back the export first", async () => {
    const a = await filled("A");
    await expect(a.client.action(api.workspace.remove, { orgId: a.orgId, confirmName: "A org" })).rejects.toMatchObject({ data: { code: "VALIDATION" } });
    const b = a.t.withIdentity({ tokenIdentifier: "clerk|B", name: "B" });
    await b.mutation(api.users.store, {});
    const invite = await a.client.mutation(api.invites.create, { orgId: a.orgId, role: "admin" });
    await b.mutation(api.invites.accept, { token: invite.token });
    await expect(b.action(api.workspace.remove, { orgId: a.orgId, confirmName: "A Org" })).rejects.toMatchObject(ownerOnly);
    expect((await a.client.query(api.orgs.get, { orgId: a.orgId })).name).toBe("A Org");
    vi.useFakeTimers();
    const kept: any = await a.client.action(api.workspace.remove, { orgId: a.orgId, confirmName: "A Org" });
    expect(kept.records.map((r: any) => r.values.name ?? r.values.title)).toContain("A Ann");
    // Access ends at once, before the rows are gone.
    await expect(a.client.query(api.orgs.get, { orgId: a.orgId })).rejects.toMatchObject(ownerOnly);
    expect(await a.client.query(api.orgs.mine, {})).toEqual([]);
    await a.t.finishAllScheduledFunctions(vi.runAllTimers);
  });

  it("removes every row of the workspace in batches and leaves the other workspace untouched", async () => {
    const a = await filled("A");
    const b = a.t.withIdentity({ tokenIdentifier: "clerk|B", name: "B" });
    await b.mutation(api.users.store, {});
    const orgB = await b.mutation(api.orgs.create, { name: "B Org" });
    const company = await objectFields(b, orgB, "company");
    await b.mutation(api.records.create, { orgId: orgB, objectId: company.object._id, values: { [company.fields.name._id]: "B secret" } });
    await seedEverywhere(a.t, a.orgId); await seedEverywhere(a.t, orgB);
    // Enough rows that one batch cannot finish the job.
    const many = await objectFields(a.client, a.orgId, "note");
    await a.t.run(async (ctx: any) => { for (let i = 0; i < 300; i++) await ctx.db.insert("records", { orgId: a.orgId, objectId: many.object._id, values: {}, title: `n${i}`, createdBy: (await ctx.db.query("users").first())._id, updatedAt: 0 }); });
    // A read-only hold does not block leaving: deletion only removes.
    await a.t.run(async (ctx: any) => ctx.db.patch(a.orgId, { flags: { readonly: true } }));
    const beforeA = await counts(a.t, a.orgId), beforeB = await counts(a.t, orgB);
    for (const name of orgTables) expect(beforeA[name], `fixture must seed ${name}`).toBeGreaterThan(0);
    vi.useFakeTimers();
    await a.client.action(api.workspace.remove, { orgId: a.orgId, confirmName: "A Org" });
    const left = async () => Object.values(await counts(a.t, a.orgId)).reduce((sum, n) => sum + n, 0) - beforeA.integrationPagesAll - beforeA.usersAll;
    const drops: number[] = [];
    for (let rows = await left(); rows > 0 && drops.length < 100;) { vi.runOnlyPendingTimers(); await a.t.finishInProgressScheduledFunctions(); const now = await left(); drops.push(rows - now); rows = now; }
    expect(Math.max(...drops)).toBeLessThanOrEqual(200);
    await a.t.finishAllScheduledFunctions(vi.runAllTimers);
    const afterA = await counts(a.t, a.orgId);
    for (const name of [...orgTables, "orgs"]) expect(afterA[name], name).toBe(0);
    expect(afterA.integrationPagesAll).toBe(beforeA.integrationPagesAll - 1);
    expect(afterA.usersAll).toBe(beforeA.usersAll);
    expect(await counts(a.t, orgB)).toEqual({ ...beforeB, integrationPagesAll: beforeB.integrationPagesAll - 1 });
    expect((await b.query(api.records.search, { orgId: orgB, text: "B secret" })).length).toBe(1);
  });
});
