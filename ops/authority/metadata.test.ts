import { expect, it } from 'vitest';
import { anyApi } from 'convex/server';
import { api, objectFields, userAndOrg } from '../../convex/test.helpers';
it('a restricted administrator cannot change invisible metadata or mint an unrestricted invite', async () => {
  const f = await userAndOrg(), company = await objectFields(f.client, f.orgId, 'company');
  const memberId = await f.t.run(async ctx => (await ctx.db.query('members').collect())[0]._id);
  await f.client.mutation(anyApi['authority/policies'].setMember, { orgId: f.orgId, memberId, scopes: [], hiddenFieldIds: [] });
  await expect.soft(f.client.mutation(api.objects.create, { orgId: f.orgId, key: 'outside', label: 'Outside', labelPlural: 'Outside' })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await expect.soft(f.client.mutation(api.fields.create, { orgId: f.orgId, objectId: company.object._id, key: 'outside', label: 'Outside', type: 'text' })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await expect.soft(f.client.mutation(api.fields.update, { orgId: f.orgId, fieldId: company.fields.city._id, label: 'Guess changed' })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await expect.soft(f.client.mutation(api.fields.retire, { orgId: f.orgId, fieldId: company.fields.city._id })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await expect.soft(f.client.mutation(api.invites.create, { orgId: f.orgId, role: 'admin' })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
});
it('readonly refuses new metadata, invitations and grants while pure revocation remains available', async () => {
  const f = await userAndOrg(), company = await objectFields(f.client, f.orgId, 'company'), agent = await f.client.action(api.agents.create, { orgId: f.orgId, name: 'old', grants: [{ action: 'update', objectKey: 'company' }] });
  await f.t.run(ctx => ctx.db.patch(f.orgId, { flags: { readonly: true } }));
  await expect.soft(f.client.mutation(api.orgs.rename, { orgId: f.orgId, name: 'New' })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await expect.soft(f.client.mutation(api.invites.create, { orgId: f.orgId, role: 'member' })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await expect.soft(f.client.mutation(api.agents.setGrants, { orgId: f.orgId, agentId: agent.agentId, grants: [{ action: 'delete', objectKey: 'company' }] })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await expect.soft(f.client.mutation(anyApi['authority/grants'].grant, { orgId: f.orgId, target: agent.agentId, capability: 'read', scope: { kind: 'records', objectId: company.object._id, records: 'all', fields: [company.fields.name._id] }, mode: 'direct', delegate: false, expiresAt: Date.now() + 60000 })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await f.client.mutation(api.agents.setGrants, { orgId: f.orgId, agentId: agent.agentId, grants: [] });
  await f.client.mutation(api.agents.revoke, { orgId: f.orgId, agentId: agent.agentId });
});
it('readonly scope changes may reduce authority but cannot combine a reduction with a new field grant', async () => {
  const f = await userAndOrg(), company = await objectFields(f.client, f.orgId, 'company'), agent = await f.client.action(api.agents.create, { orgId: f.orgId, name: 'masked' });
  const policy = anyApi['authority/policies'];
  await f.client.mutation(policy.setAgentMasks, { orgId: f.orgId, agentId: agent.agentId, hiddenFieldIds: [company.fields.name._id] });
  await f.t.run(ctx => ctx.db.patch(f.orgId, { flags: { readonly: true } }));
  await expect.soft(f.client.mutation(policy.setAgentMasks, { orgId: f.orgId, agentId: agent.agentId, hiddenFieldIds: [company.fields.city._id] })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
  await f.client.mutation(policy.setAgentMasks, { orgId: f.orgId, agentId: agent.agentId, hiddenFieldIds: [company.fields.name._id, company.fields.city._id] });
});
it('an invitation cannot create unrestricted access after its issuer loses that authority', async () => {
  const f = await userAndOrg(), invite = await f.client.mutation(api.invites.create, { orgId: f.orgId, role: 'admin' });
  const memberId = await f.t.run(async ctx => (await ctx.db.query('members').collect())[0]._id);
  await f.client.mutation(anyApi['authority/policies'].setMember, { orgId: f.orgId, memberId, scopes: [], hiddenFieldIds: [] });
  const guest = f.t.withIdentity({ tokenIdentifier: 'clerk|guest' }); await guest.mutation(api.users.store, {});
  await expect(guest.mutation(api.invites.accept, { token: invite.token })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
});
it('removing and rejoining an invitation issuer never revives the old invitation', async () => {
  const f = await userAndOrg(), invite = await f.client.mutation(api.invites.create, { orgId: f.orgId, role: 'admin' });
  await f.t.run(async ctx => { const member = (await ctx.db.query('members').collect())[0]; await ctx.db.delete(member._id); await ctx.db.insert('members', { orgId: f.orgId, userId: member.userId, role: 'owner' }); });
  const guest = f.t.withIdentity({ tokenIdentifier: 'clerk|replacement-guest' }); await guest.mutation(api.users.store, {});
  await expect(guest.mutation(api.invites.accept, { token: invite.token })).rejects.toMatchObject({ data: { code: 'FORBIDDEN' } });
});
it('membership authority changes retain an attributed audit after the membership row is removed', async () => {
  const f = await userAndOrg(), guest = f.t.withIdentity({ tokenIdentifier: 'clerk|member-audit' }); await guest.mutation(api.users.store, {});
  const invited = await f.client.mutation(api.invites.create, { orgId: f.orgId, role: 'admin' }); await guest.mutation(api.invites.accept, { token: invited.token });
  const guestUser = await guest.query(api.users.me, {});
  await f.client.mutation(api.orgs.setRole, { orgId: f.orgId, userId: guestUser!._id, role: 'member' });
  await f.client.mutation(api.orgs.removeMember, { orgId: f.orgId, userId: guestUser!._id });
  const rows = await f.t.run(ctx => ctx.db.query('authorityAudit').collect());
  expect(rows.filter(r => ['membershipRoleChanged', 'membershipRemoved'].includes(r.action)).map(r => [r.action, r.actor.kind])).toEqual([['membershipRoleChanged', 'user'], ['membershipRemoved', 'user']]);
});
