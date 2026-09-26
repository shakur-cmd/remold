import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { withRecurring } from './local.mjs';
import { trustedAdapter } from '../adapter.mjs';
await withRecurring(async ({ url, run }) => {
    const client = new ConvexHttpClient(url, { logger: false }), f = run('harness:seed', { run: randomUUID(), tokens: Array.from({ length: 10 }, () => randomUUID()) });
    const m = (name, args) => client.mutation(makeFunctionReference('payments:' + name), args);
    const customer = await m('registerCustomer', {
        token: f.A.adapter,
        binding: f.A.binding,
        externalId: 'cus_synthetic_recurring',
        name: 'Synthetic recurring customer'
    });
    const document = await m('prepareInvoice', {
        token: f.A.sessions.owner,
        customer,
        amountMinor: 903,
        currency: 'usd',
        kind: 'recurring'
    });
    let effects = 0, refusal;
    const stripe = { request: async () => {
            effects++;
            return { id: 'sub_sched_synthetic' };
        } };
    try {
        await trustedAdapter(stripe, client, f).execute('A', document, {
            customer: 'cus_synthetic_recurring',
            end_behavior: 'cancel',
            start_date: 'now',
            'phases[0][items][0][price]': 'price_synthetic',
            'phases[0][iterations]': 3
        }, 'POST', '/v1/subscription_schedules');
    }
    catch (e) {
        refusal = e.message;
    }
    console.log(JSON.stringify({
        baseline: 'Accepted one-off adapter cannot activate finite recurring commitment; intentional closed route, not an unsafe H0 defect',
        effects,
        refusal
    }));
    assert.equal(effects, 1, 'Recurring activation is not implemented in accepted baseline');
}, { baseline: true });
