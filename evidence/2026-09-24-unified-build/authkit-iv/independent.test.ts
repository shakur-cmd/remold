import { it, expect } from 'vitest';
import { makeTest } from '../../../convex/test.setup';
import { api } from '../../../convex/_generated/api';
import { authReturnTarget } from '../../../src/lib/identity-route';

it('a same-email WorkOS identity cannot inherit a Clerk membership or forge it with display data', async () => {
  const t = makeTest();
  const old = t.withIdentity({ tokenIdentifier: 'https://old.clerk.invalid|user_1', email: 'same@example.invalid' });
  const fresh = t.withIdentity({ tokenIdentifier: 'https://api.workos.com/user_management/client_fixture|user_1', email: 'same@example.invalid' });
  const oldId = await old.mutation(api.users.store, {});
  const orgId = await old.mutation(api.orgs.create, {name: 'Existing synthetic workspace'});
  const freshId = await fresh.mutation(api.users.store, { profile: {name:'Old owner',email:'same@example.invalid'} });
  expect(freshId).not.toBe(oldId);
  expect(await fresh.query(api.orgs.mine, {})).toEqual([]);
  await expect(fresh.query(api.orgs.get, {orgId})).rejects.toMatchObject({data:{code:'FORBIDDEN'}});
  await expect(fresh.mutation(api.invites.create, {orgId,role:'admin'})).rejects.toMatchObject({data:{code:'FORBIDDEN'}});
  expect((await old.query(api.orgs.members, {orgId})).map(x=>x.user._id)).toEqual([oldId]);
});
it('independent return corpus never escapes origin and preserves valid deep destinations', () => {
  const origin='https://preview.example.invalid';
  const attacks=['///evil.invalid','////evil.invalid','//user@evil.invalid','/\\evil.invalid','/\r/evil.invalid','/\t/evil.invalid','/\u0000/evil.invalid','https://preview.example.invalid.evil.invalid/x','https://preview.example.invalid:444/x','https://preview.example.invalid@evil.invalid/x','HTTPS://EVIL.INVALID/x','https:evil.invalid','https://preview.example.invalid/../../callback?code=x','/%2e%2e/callback','//evil.invalid/#/invite/t','/\\\\evil.invalid','\u2000//evil.invalid'];
  for(const value of attacks) expect(authReturnTarget(value,origin),value).toBe('/');
  for(const path of ['/invite/abc?next=//evil.invalid#note','/o/one/person/two','/o/one/person/%2f%2fevil.invalid','/#/invite/abc']) expect(authReturnTarget(path,origin),path).toBe(path);
});
