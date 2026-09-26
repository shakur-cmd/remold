import assert from 'node:assert/strict';
import { anyApi } from 'convex/server';
import { withAuthority } from './local.mjs';
import { tenant, financial } from './service-fixture.mjs';
await withAuthority(async runtime => {
  runtime.run('integrations/connections:registerProvider', { provider: 'fake', enabled: true });
  const t = await tenant(runtime, 'watchdog');
  const { targetId } = await financial(t);
  const id = await t.human.mutation(anyApi['integrations/safety'].prepare, { orgId: t.orgId, targetId, logical: 'stuck', kind: 'refund', amountMinor: 5 });
  await t.human.mutation(anyApi['integrations/safety'].consume, { orgId: t.orgId, id }); await new Promise(r => setTimeout(r, 2300));
  const op = await t.get(id); console.log(JSON.stringify({ state: op.state, reserved: op.safety.reservationActive })); assert.equal(op.state, 'outcomeUnknown'); assert.equal(op.safety.reservationActive, true);
  console.log('PASS stuck scheduled safety action becomes unknown without freeing headroom'); return { status: 'PASS' };
}, { safetySim: true, safetyHang: true });
