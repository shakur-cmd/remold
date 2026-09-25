import assert from 'node:assert/strict';
import { anyApi } from 'convex/server';
import { withAuthority } from './local.mjs';
import { tenant, financial } from './service-fixture.mjs';
await withAuthority(async runtime => {
  runtime.run('integrations/connections:registerProvider', { provider: 'fake', enabled: true });
  const t = await tenant(runtime, 'unimplemented'), { targetId } = await financial(t);
  const id = await t.human.mutation(anyApi['integrations/safety'].prepare, { orgId: t.orgId, targetId, logical: 'blocked', kind: 'refund', amountMinor: 5 });
  await assert.rejects(t.human.mutation(anyApi['integrations/safety'].consume, { orgId: t.orgId, id }), /adapter is not implemented/);
  assert.equal(t.dump().safetyTargets[0].pendingRefundMinor, 0);
  assert.equal((await t.get(id)).permitUsed, false);
  console.log('PASS unchanged production registry refuses before reservation or final consume');
});
