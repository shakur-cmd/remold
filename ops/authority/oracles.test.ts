import { expect, it } from 'vitest';
import { anyApi } from 'convex/server';
import { api, objectFields, rest, userAndOrg } from '../../convex/test.helpers';

// A name that exists only in records the caller cannot read must produce exactly
// the same outcome as a name that does not exist at all (IV defects D1 to D3).
const outcome = async (call: () => Promise<unknown>) => { try { return { ok: true, value: await call() }; } catch (error: any) { return { ok: false, error: error?.data ?? String(error) }; } };
const SECRET = 'Secret Merger Target', MISSING = 'Nobody By This Name';

async function scopedWorkspace() {
  const f = await userAndOrg(), company = await objectFields(f.client, f.orgId, 'company');
  const mine = (await f.client.mutation(api.records.create, { orgId: f.orgId, objectId: company.object._id, values: { [company.fields.name._id]: 'My Co' } })).recordId;
  await f.client.mutation(api.records.create, { orgId: f.orgId, objectId: company.object._id, values: { [company.fields.name._id]: SECRET } });
  return { ...f, company, mine };
}
async function restrictToMine(f: Awaited<ReturnType<typeof scopedWorkspace>>, extra: any[] = []) {
  const memberId = await f.t.run(async ctx => (await ctx.db.query('members').collect())[0]!._id);
  await f.client.mutation(anyApi['authority/policies'].setMember, { orgId: f.orgId, memberId, scopes: [{ objectId: f.company.object._id, records: [f.mine], fields: 'all' }, ...extra], hiddenFieldIds: [] });
}

it('CSV import skips only readable duplicates; an unreadable existing name looks like a new one', async () => {
  const f = await scopedWorkspace(); await restrictToMine(f);
  const result: any = await f.client.mutation(api.csv.importRows, { orgId: f.orgId, objectId: f.company.object._id, columns: [f.company.fields.name._id], rows: [['My Co'], [SECRET], [MISSING]], firstRow: 2, skipDuplicates: true, createMissing: false });
  expect(result.skipped).toBe(1);
  expect(result.errors.map((e: any) => e.row)).toEqual([3, 4]);
  expect(result.errors[0].message).toBe(result.errors[1].message);
});

it('CSV lookup columns treat an unreadable linked name like a missing one', async () => {
  const f = await scopedWorkspace(), person = await objectFields(f.client, f.orgId, 'person'); await restrictToMine(f, [{ objectId: person.object._id, records: 'all', fields: 'all' }]);
  const row = async (name: string) => ((await f.client.mutation(api.csv.importRows, { orgId: f.orgId, objectId: person.object._id, columns: [person.fields.name._id, person.fields.company._id], rows: [['Pat', name]], firstRow: 2, skipDuplicates: false, createMissing: false })) as any).errors.map((e: any) => e.message.replace(name, '<name>'));
  expect(await row(SECRET)).toEqual(await row(MISSING));
});

it('browser capture treats an unreadable existing company like a missing one', async () => {
  const f = await scopedWorkspace(); await restrictToMine(f);
  const save = (name: string) => outcome(() => f.client.mutation(api.capture.save, { orgId: f.orgId, kind: 'company', name }));
  expect(await save(SECRET)).toEqual(await save(MISSING));
  expect(await save('My Co')).toMatchObject({ ok: true, value: { companyCreated: false, recordId: f.mine } });
});

it('agent proposals check proposal scope before resolving a lookup by name', async () => {
  const f = await scopedWorkspace(), person = await objectFields(f.client, f.orgId, 'person');
  const pat = (await f.client.mutation(api.records.create, { orgId: f.orgId, objectId: person.object._id, values: { [person.fields.name._id]: 'Pat' } })).recordId;
  const agent = await f.client.action(api.agents.createScoped, { orgId: f.orgId, name: 'scoped', origin: 'external' });
  const grant = (capability: string, objectId: any, records: any, fields: any[]) => f.client.mutation(anyApi['authority/grants'].grant, { orgId: f.orgId, target: agent.agentId, capability, scope: { kind: 'records', objectId, records, fields }, mode: 'direct', delegate: false, expiresAt: Date.now() + 600000 });
  await grant('read', person.object._id, [pat], Object.values(person.fields).map((x: any) => x._id));
  await grant('read', f.company.object._id, [f.mine], Object.values(f.company.fields).map((x: any) => x._id));
  const call = rest(f.t, agent.key), propose = async (name: string) => { const r = await call('POST', '/api/v1/suggestions', { action: 'update', record: pat, values: { company: name }, reason: 'oracle' }); return { status: r.status, body: JSON.stringify(r.json).replace(name, '<name>') }; };
  // Read-only agent: refused for lack of proposal scope, whatever the name.
  expect(await propose(SECRET)).toEqual({ status: 403, body: JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Proposal scope required' } }) });
  expect(await propose(MISSING)).toEqual(await propose(SECRET));
  // With proposal scope, an unreadable name and a missing one give the same validation error.
  await grant('propose', person.object._id, [pat], [person.fields.company._id]);
  const secret = await propose(SECRET);
  expect(secret.status).toBe(400); expect(secret).toEqual(await propose(MISSING));
  expect((await propose('My Co')).status).toBe(201);
});
