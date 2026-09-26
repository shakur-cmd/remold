import assert from 'node:assert/strict';
import { anyApi } from 'convex/server';
import { withAuthority } from './local.mjs';
import { tenant, financial } from './service-fixture.mjs';
await withAuthority(async runtime => {
  runtime.run('integrations/connections:registerProvider', { provider: 'fake', enabled: true, finalityRules: [{ capability: 'billing.refund', semantics: 'SIM declared absence', proofRef: 'SIM: deterministic no-provider absence' }] });
  const t = await tenant(runtime, 'finality-race'), finance = await financial(t), { targetId } = finance;
  const id = await t.human.mutation(anyApi['integrations/safety'].prepare, { orgId: t.orgId, targetId, logical: 'stuck', kind: 'refund', amountMinor: 5 });
  await t.human.mutation(anyApi['integrations/safety'].consume, { orgId: t.orgId, id });
  const started = await finance.pull([], false);
  const resource = `financial:${targetId}:${started.generation}`;
  await t.adapter('page', { resource, traversal: 'race', from: 0, page: 1, items: [], end: true, checkpoint: started.generation });
  await new Promise(r => setTimeout(r, 2300));
  assert.equal((await t.get(id)).state, 'outcomeUnknown');
  const lookupId = await t.adapter('lookup', { resource });
  await t.adapter('safety-complete', { ...started, paidMinor: 10, cancelled: false, lookupId });
  let refused = false, reason; try { await t.adapter('safety-resolve-unknown', { id, lookupId }); } catch (error) { refused = true; reason = error.message; }
  const op = await t.get(id); console.log(JSON.stringify({ timeline: 'consume; read while send hangs; watchdog; seal; finality request', refused, reason, state: op.state, held: t.dump().safetyTargets[0].pendingRefundMinor }));
  assert.equal(refused, true); assert.match(reason, /after the send action exits/); assert.equal(t.dump().safetyTargets[0].pendingRefundMinor, 5);
  console.log('PASS in-flight send cannot be finalized by a later-completing lookup');
}, { safetySim: true, safetyHang: true });
