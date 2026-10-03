import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import { agentFor, api, objectFields, rest, userAndOrg } from "./test.helpers";

// Admins widen or narrow what an agent reads, so agents keep up as the CRM is reshaped.
const setAccess = (client: any, orgId: any, agentId: any, readAllObjects: boolean, objectIds: any[]) => client.mutation(api.agents.setReadAccess, { orgId, agentId, readAllObjects, objectIds });
const listed = async (client: any, orgId: any, agentId: any) => (await client.query(api.agents.list, { orgId })).find((a: any) => a._id === agentId);
const audit = (t: any, agentId: any) => t.run(async (ctx: any) => (await ctx.db.query("authorityAudit").collect()).filter((row: any) => row.targetId === agentId).map((row: any) => row.action));
async function venue(client: any, orgId: any) {
  const objectId = await client.mutation(api.objects.create, { orgId, key: "venue", label: "Venue", labelPlural: "Venues" });
  await client.mutation(api.fields.create, { orgId, objectId, key: "capacity", label: "Capacity", type: "number" });
  const { fields } = await objectFields(client, orgId, "venue");
  const recordId = (await client.mutation(api.records.create, { orgId, objectId, values: { [fields.name._id]: "Hall", [fields.capacity._id]: 200 } })).recordId;
  return { objectId, fields, recordId };
}
async function member(t: any, orgId: any, role: "admin" | "member", name = role) {
  const client = t.withIdentity({ tokenIdentifier: `clerk|${name}`, name });
  await client.mutation(api.users.store, {});
  const user = await client.query(api.users.me, {});
  const memberId = await t.run((ctx: any) => ctx.db.insert("members", { orgId, userId: user!._id, role }));
  return { client, memberId };
}

describe("agent object access", () => {
  it("an agent made before an object existed cannot read it, can after Let it read, and loses it, with any in-flight proposal, when removed", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "early" }), call = rest(t, agent.key);
    const v = await venue(client, orgId);
    expect((await call("GET", "/api/v1/objects")).json.map((o: any) => o.key)).not.toContain("venue");
    expect((await call("GET", "/api/v1/records?object=venue")).status).toBe(404);
    expect((await call("POST", "/api/v1/suggestions", { action: "create", object: "venue", values: { name: "Annex" }, reason: "x" })).status).toBe(404);
    const before = await listed(client, orgId, agent.agentId);
    expect(before.cannotRead).toEqual(["venue"]);

    await setAccess(client, orgId, agent.agentId, false, [...before.readObjectIds, v.objectId]);
    expect((await listed(client, orgId, agent.agentId)).cannotRead).toEqual([]);
    expect((await call("GET", "/api/v1/records?object=venue")).json.records.map((r: any) => r.values)).toEqual([{ name: "Hall", capacity: 200 }]);
    const proposed = await call("POST", "/api/v1/suggestions", { action: "create", object: "venue", values: { name: "Annex" }, reason: "x" });
    expect(proposed.status).toBe(201);

    await setAccess(client, orgId, agent.agentId, false, before.readObjectIds);
    expect((await call("GET", "/api/v1/records?object=venue")).status).toBe(404);
    // The epoch moved, so the proposal made under the wider access cannot be applied as the agent's.
    await expect(client.mutation(api.suggestions.apply, { orgId, suggestionId: proposed.json.suggestion.id })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    expect(await audit(t, agent.agentId)).toEqual(["legacyGrantsFrozen", "agentReadAccessChanged", "agentReadAccessChanged"]);
    expect((await t.run((ctx: any) => ctx.db.get(agent.agentId)) as any).authorityEpoch).toBe(2);
  });

  it("reading all objects covers objects added later, and hidden fields stay hidden", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "all" }), call = rest(t, agent.key);
    await setAccess(client, orgId, agent.agentId, true, []);
    const v = await venue(client, orgId);
    expect(await listed(client, orgId, agent.agentId)).toMatchObject({ readAllObjects: true, cannotRead: [] });
    expect((await call("GET", "/api/v1/records?object=venue")).json.records[0].values).toEqual({ name: "Hall", capacity: 200 });
    await client.mutation(api.authority.policies.setAgentMasks, { orgId, agentId: agent.agentId, hiddenFieldIds: [v.fields.capacity._id] });
    expect((await call("GET", "/api/v1/records?object=venue")).json.records[0].values).toEqual({ name: "Hall" });
    expect((await call("GET", "/api/v1/objects")).json.find((o: any) => o.key === "venue").fields.map((f: any) => f.key)).toEqual(["name"]);
    expect((await call("GET", `/api/v1/records/${v.recordId}`)).json.record.values).toEqual({ name: "Hall" });
    // Turning it off with every current object listed (as Settings does) keeps those and stops covering objects added after.
    await setAccess(client, orgId, agent.agentId, false, (await client.query(api.objects.list, { orgId })).map((o: any) => o._id));
    await client.mutation(api.objects.create, { orgId, key: "room", label: "Room", labelPlural: "Rooms" });
    expect((await call("GET", "/api/v1/objects")).json.map((o: any) => o.key)).toContain("venue");
    expect((await call("GET", "/api/v1/records?object=room")).status).toBe(404);
  });

  it("reading never implies writing, and removing read drops write grants so reading again does not bring them back", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "reader" }), call = rest(t, agent.key);
    const v = await venue(client, orgId), base = (await listed(client, orgId, agent.agentId)).readObjectIds;
    await setAccess(client, orgId, agent.agentId, true, []);
    const create = () => call("POST", "/api/v1/changes", { action: "create", object: "venue", values: { name: "Annex" }, reason: "x" });
    expect((await create()).status).toBe(403);
    expect((await call("POST", "/api/v1/changes", { action: "update", record: v.recordId, values: { name: "Big hall" }, reason: "x" })).status).toBe(403);
    await client.mutation(api.agents.setGrants, { orgId, agentId: agent.agentId, grants: [{ action: "create", objectKey: "venue" }, { action: "create", objectKey: "company" }] });
    await client.mutation(api.authority.policies.setAgentMasks, { orgId, agentId: agent.agentId, hiddenFieldIds: [v.fields.capacity._id] });
    expect((await create()).status).toBe(200);
    await setAccess(client, orgId, agent.agentId, false, base);
    expect((await listed(client, orgId, agent.agentId)).grants).toEqual([{ action: "create", objectKey: "company" }]);
    await setAccess(client, orgId, agent.agentId, false, [...base, v.objectId]);
    expect((await create()).status).toBe(403);
    // Hidden-field entries are kept while unreadable (they hide nothing then) and hide again once it reads.
    expect((await t.run((ctx: any) => ctx.db.get(agent.agentId)) as any).hiddenFieldIds).toEqual([v.fields.capacity._id]);
    expect((await call("GET", `/api/v1/records/${v.recordId}`)).json.record.values).toEqual({ name: "Hall" });
  });

  it("only unrestricted admins change access, for live agents with no fixed job, to objects in their own workspace", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "worker" }), v = await venue(client, orgId);
    const { client: plain } = await member(t, orgId, "member");
    await expect(setAccess(plain, orgId, agent.agentId, true, [])).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    const { client: admin, memberId } = await member(t, orgId, "admin");
    await setAccess(admin, orgId, agent.agentId, false, [v.objectId]);
    await t.run((ctx: any) => ctx.db.patch(memberId, { hiddenFieldIds: [v.fields.capacity._id] }));
    await expect(setAccess(admin, orgId, agent.agentId, true, [])).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    await setAccess(admin, orgId, agent.agentId, false, []);
    const intake = await client.action(api.agents.createIntake, { orgId });
    const gmail = await client.action(api.agents.createGmailSync, { orgId });
    const scoped = await client.action(api.agents.createScoped, { orgId, name: "bounded", origin: "external" });
    for (const fixed of [intake, gmail, scoped]) {
      await expect(setAccess(client, orgId, fixed.agentId, true, [])).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
      expect((await listed(client, orgId, fixed.agentId)).fixedScope).toBe(true);
    }
    const otherOrg = await client.mutation(api.orgs.create, { name: "Other Org" }), foreign = (await client.query(api.objects.list, { orgId: otherOrg }))[0]._id;
    await expect(setAccess(client, orgId, agent.agentId, false, [foreign])).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await expect(setAccess(client, otherOrg, agent.agentId, true, [])).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await client.mutation(api.agents.revoke, { orgId, agentId: agent.agentId });
    await expect(setAccess(client, orgId, agent.agentId, true, [])).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    expect((await listed(client, orgId, agent.agentId)).readObjectIds).toEqual([]);
  });

  it("an agent learns what it can read from /me", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "me" }), call = rest(t, agent.key);
    const v = await venue(client, orgId);
    const me = (await call("GET", "/api/v1/me")).json;
    expect(me.agent.readsAllObjects).toBe(false);
    expect(me.agent.readableObjects).toContain("person");
    expect(me.agent.readableObjects).not.toContain("venue");
    await setAccess(client, orgId, agent.agentId, false, [v.objectId]);
    expect((await call("GET", "/api/v1/me")).json.agent).toMatchObject({ readsAllObjects: false, readableObjects: ["venue"] });
    await setAccess(client, orgId, agent.agentId, true, []);
    const all = (await call("GET", "/api/v1/me")).json.agent;
    expect(all.readsAllObjects).toBe(true);
    expect(all.readableObjects).toEqual(expect.arrayContaining(["person", "venue", "email"]));
  });

  it("an agent made before Email existed drafts an email and reads the campaign report once an admin lets it read Email", async () => {
    const { t, client, orgId } = await userAndOrg();
    const [person, campaign, email] = await Promise.all(["person", "campaign", "email"].map((key) => objectFields(client, orgId, key)));
    // An older workspace: no Email object yet when the agent is made.
    await t.run(async (ctx: any) => {
      for (const field of await ctx.db.query("fields").collect()) if (field.objectId === email.object._id) await ctx.db.delete(field._id);
      await ctx.db.delete(email.object._id);
    });
    const agent = await agentFor(client, orgId, { name: "campaigner" }), call = rest(t, agent.key);
    await t.mutation(internal.seed.ensureStandard, { orgId });
    const added = await objectFields(client, orgId, "email");
    const ava = (await client.mutation(api.records.create, { orgId, objectId: person.object._id, values: { [person.fields.name._id]: "Ava Stone", [person.fields.email._id]: "ava@people.test" } })).recordId;
    const campaignId = (await client.mutation(api.records.create, { orgId, objectId: campaign.object._id, values: { [campaign.fields.name._id]: "Calls", [campaign.fields.status._id]: "active", [campaign.fields.channel._id]: "email", [campaign.fields.people._id]: [ava] } })).recordId;
    const draft = { action: "create", object: "email", values: { subject: "Hi {{firstName|there}}", body: "Five minutes?", campaign: campaignId, status: "draft" }, reason: "first touch" };
    expect((await call("POST", "/api/v1/suggestions", draft)).status).toBe(404);
    expect((await call("GET", `/api/v1/campaigns/${campaignId}/report`)).json.emails).toEqual([]);
    expect((await listed(client, orgId, agent.agentId)).cannotRead).toEqual(["email"]);

    const { readObjectIds } = await listed(client, orgId, agent.agentId);
    await setAccess(client, orgId, agent.agentId, false, [...readObjectIds, added.object._id]);
    const proposed = await call("POST", "/api/v1/suggestions", draft);
    expect(proposed.status).toBe(201);
    expect((await call("POST", "/api/v1/changes", draft)).status).toBe(403);
    await client.mutation(api.suggestions.apply, { orgId, suggestionId: proposed.json.suggestion.id });
    const report = await call("GET", `/api/v1/campaigns/${campaignId}/report`);
    expect(report.status).toBe(200);
    expect(report.json.emails).toEqual([expect.objectContaining({ subject: "Hi {{firstName|there}}", status: "draft", problems: expect.arrayContaining(["Not approved yet"]) })]);
    const preview = await call("GET", `/api/v1/emails/${report.json.emails[0].id}/preview?person=${ava}`);
    expect(preview.status).toBe(200);
  });
});

describe("agent object access, round 2", () => {
  const scopeTo = (client: any, orgId: any, memberId: any, objectIds: any[]) => client.mutation(api.authority.policies.setMember, { orgId, memberId, scopes: objectIds.map((objectId) => ({ objectId, records: "all", fields: "all" })), hiddenFieldIds: [] });
  const objectId = async (client: any, orgId: any, key: string) => (await client.query(api.objects.list, { orgId })).find((o: any) => o.key === key)._id;

  it("an admin who sees only some objects changes only those; the agent keeps everything else", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "worker", grants: [{ action: "create", objectKey: "company" }] }), call = rest(t, agent.key);
    const v = await venue(client, orgId), person = await objectId(client, orgId, "person"), company = await objectId(client, orgId, "company");
    await setAccess(client, orgId, agent.agentId, false, [...(await listed(client, orgId, agent.agentId)).readObjectIds, v.objectId]);
    // Older data: a grant on Opportunities, which it no longer reads. It is not the restricted admin's to remove.
    const opportunity = await objectId(client, orgId, "opportunity");
    await setAccess(client, orgId, agent.agentId, false, (await listed(client, orgId, agent.agentId)).readObjectIds.filter((id: any) => id !== opportunity));
    await t.run(async (ctx: any) => { const a = await ctx.db.get(agent.agentId); await ctx.db.patch(agent.agentId, { grants: [...a.grants, { action: "update", objectKey: "opportunity", objectId: opportunity }] }); });
    const { client: admin, memberId } = await member(t, orgId, "admin");
    await scopeTo(client, orgId, memberId, [person, v.objectId]);
    // What the Access panel sends when this admin unticks Venues: the objects it can see, minus Venues.
    const seen = (await admin.query(api.objects.list, { orgId })).map((o: any) => o._id);
    expect(seen.length).toBe(2);
    await setAccess(admin, orgId, agent.agentId, false, seen.filter((id: any) => id !== v.objectId));
    expect((await listed(client, orgId, agent.agentId)).cannotRead).toEqual(["opportunity", "venue"]);
    expect((await listed(client, orgId, agent.agentId)).grants).toEqual([{ action: "create", objectKey: "company" }]);
    expect((await t.run((ctx: any) => ctx.db.get(agent.agentId)) as any).grants.map((g: any) => `${g.action} ${g.objectKey}`)).toEqual(["create company", "update opportunity"]);
    expect((await call("GET", "/api/v1/records?object=company")).status).toBe(200);
    expect((await call("POST", "/api/v1/changes", { action: "create", object: "company", values: { name: "Kept" }, reason: "x" })).status).toBe(200);
    // Objects it cannot see are not its to change, and the All objects switch covers them too.
    await expect(setAccess(admin, orgId, agent.agentId, false, [person, company])).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await setAccess(client, orgId, agent.agentId, true, []);
    await expect(setAccess(admin, orgId, agent.agentId, false, [person])).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    // Settings names only objects the viewer can read.
    await setAccess(client, orgId, agent.agentId, false, (await listed(client, orgId, agent.agentId)).readObjectIds.filter((id: any) => id !== company && id !== v.objectId));
    expect((await listed(client, orgId, agent.agentId)).cannotRead).toEqual(["company", "venue"]);
    expect((await listed(admin, orgId, agent.agentId)).cannotRead).toEqual(["venue"]);
  });

  it("an agent sees the shared inbox only while it reads every object", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "inbox" }), call = rest(t, agent.key);
    await client.mutation(api.agents.setSharedInbox, { orgId, agentId: agent.agentId, enabled: true });
    await client.mutation(api.inbox.add, { orgId, text: "Venue Hall capacity is secret", shareWithAgents: true });
    const shared = async () => (await call("GET", "/api/v1/inbox")).json.length;
    expect(await shared()).toBe(1);
    expect((await listed(client, orgId, agent.agentId)).inboxNeedsAll).toBe(false);
    await venue(client, orgId);
    expect(await shared()).toBe(0);
    expect((await listed(client, orgId, agent.agentId)).inboxNeedsAll).toBe(true);
    await setAccess(client, orgId, agent.agentId, true, []);
    await client.mutation(api.objects.create, { orgId, key: "room", label: "Room", labelPlural: "Rooms" });
    expect(await shared()).toBe(1);
    expect((await listed(client, orgId, agent.agentId)).inboxNeedsAll).toBe(false);
  });

  it("removing read revokes capability write grants on that object, and the list hides grants on objects it cannot read", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "capable" }), call = rest(t, agent.key);
    const v = await venue(client, orgId), base = (await listed(client, orgId, agent.agentId)).readObjectIds;
    await setAccess(client, orgId, agent.agentId, false, [...base, v.objectId]);
    const grantId = await client.mutation(api.authority.grants.grant, { orgId, target: agent.agentId, capability: "record.update", scope: { kind: "records", objectId: v.objectId, records: "all", fields: [v.fields.name._id] }, mode: "direct", delegate: false, expiresAt: Date.now() + 86400000 });
    const update = () => call("POST", "/api/v1/changes", { action: "update", record: v.recordId, values: { name: "Big hall" }, reason: "x" });
    expect((await update()).status).toBe(200);
    expect((await listed(client, orgId, agent.agentId)).access).toEqual(["update venue"]);
    await setAccess(client, orgId, agent.agentId, false, base);
    expect((await t.run((ctx: any) => ctx.db.get(grantId)) as any).revokedAt).toBeDefined();
    expect(await audit(t, grantId)).toEqual(["capabilityGranted", "capabilityRevoked"]);
    await setAccess(client, orgId, agent.agentId, false, [...base, v.objectId]);
    expect((await update()).status).toBe(403);
    // A grant on an object it cannot read (older data) is not shown.
    await setAccess(client, orgId, agent.agentId, false, base);
    await t.run((ctx: any) => ctx.db.patch(agent.agentId, { grants: [{ action: "create", objectKey: "venue", objectId: v.objectId }] }));
    expect((await listed(client, orgId, agent.agentId)).grants).toEqual([]);
  });

  it("a read-all agent proposes on objects added later", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "proposer" });
    await setAccess(client, orgId, agent.agentId, true, []);
    await venue(client, orgId);
    expect((await rest(t, agent.key)("POST", "/api/v1/suggestions", { action: "create", object: "venue", values: { name: "Annex" }, reason: "x" })).status).toBe(201);
  });

  it("widening is refused while the workspace is read only; narrowing is not", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "held" }), v = await venue(client, orgId), base = (await listed(client, orgId, agent.agentId)).readObjectIds;
    await t.run((ctx: any) => ctx.db.patch(orgId, { flags: { readonly: true } }));
    await expect(setAccess(client, orgId, agent.agentId, false, [...base, v.objectId])).rejects.toMatchObject({ data: { message: "Workspace is read only" } });
    await expect(setAccess(client, orgId, agent.agentId, true, [])).rejects.toMatchObject({ data: { message: "Workspace is read only" } });
    await setAccess(client, orgId, agent.agentId, false, base.slice(1));
  });

  it("/me ignores the read-all flag on an agent that has not been migrated", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "old" });
    await t.run(async (ctx: any) => { await ctx.db.patch(orgId, { authorityFrozenAt: Date.now() }); await ctx.db.patch(agent.agentId, { authorityVersion: undefined, readAllObjects: true }); });
    await venue(client, orgId);
    const me = (await rest(t, agent.key)("GET", "/api/v1/me")).json.agent;
    expect(me.readsAllObjects).toBe(false);
    expect(me.readableObjects).not.toContain("venue");
  });

  it("write grants need read first", async () => {
    const { t, client, orgId } = await userAndOrg();
    const agent = await agentFor(client, orgId, { name: "granted" }), call = rest(t, agent.key);
    const v = await venue(client, orgId);
    await expect(client.mutation(api.agents.setGrants, { orgId, agentId: agent.agentId, grants: [{ action: "create", objectKey: "venue" }] })).rejects.toMatchObject({ data: { code: "FORBIDDEN", message: "Let it read Venues before it changes them" } });
    await expect(client.mutation(api.agents.setGrants, { orgId, agentId: agent.agentId, grants: [{ action: "create", objectKey: "*" }] })).rejects.toMatchObject({ data: { message: "Let it read Venues before it changes them" } });
    await client.mutation(api.agents.setGrants, { orgId, agentId: agent.agentId, grants: [{ action: "create", objectKey: "company" }] });
    await setAccess(client, orgId, agent.agentId, false, [...(await listed(client, orgId, agent.agentId)).readObjectIds, v.objectId]);
    expect((await call("POST", "/api/v1/changes", { action: "create", object: "venue", values: { name: "Annex" }, reason: "x" })).status).toBe(403);
  });
});
