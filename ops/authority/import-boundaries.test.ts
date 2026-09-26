import { expect, it } from 'vitest';
import { anyApi } from 'convex/server';
import { api, objectFields, userAndOrg } from '../../convex/test.helpers';
it('capture and CSV duplicate detection cannot reveal a hidden title by matching it', async () => {
  const f = await userAndOrg(), company = await objectFields(f.client, f.orgId, 'company');
  await f.client.mutation(api.records.create, { orgId: f.orgId, objectId: company.object._id, values: { [company.fields.name._id]: 'Hidden lookup title' } });
  const memberId = await f.t.run(async ctx => (await ctx.db.query('members').collect())[0]._id);
  await f.client.mutation(anyApi['authority/policies'].setMember, { orgId: f.orgId, memberId, hiddenFieldIds: [company.fields.name._id] });
  await expect.soft(f.client.mutation(api.capture.save, { orgId: f.orgId, kind: 'company', name: 'Hidden lookup title' })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } });
  await expect.soft(f.client.mutation(api.csv.importRows, { orgId: f.orgId, objectId: company.object._id, columns: [company.fields.name._id], rows: [['Hidden lookup title']], firstRow: 1, skipDuplicates: true, createMissing: false })).rejects.toMatchObject({ data: { code: 'NOT_FOUND' } });
});
