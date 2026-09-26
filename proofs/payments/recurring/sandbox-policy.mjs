import assert from 'node:assert/strict';
export const D = 'acct_1UJIndJL8hhTtG1o', E = 'acct_1UJL2DR59Pk6MTFE';
export const RUN = 'p4-recurring-finite-2026-09-24-1';
export const CAPS = Object.freeze({clock:2,advance:14,customer:2,product:1,price:1,setup:4,activate:3,card:2,cancel:2});
const keys = (params, names) => assert.deepEqual(Object.keys(params).sort(), [...names].sort(), 'Unexpected sandbox write fields');
export function boundedRecurringProvider(raw, journal, registry, start, prior = {}) {
    const provider = journal.wrap(raw), counts = Object.fromEntries(Object.keys(CAPS).map(k => [k, prior.counts?.[k] ?? 0])), used = new Set(prior.keys ?? []), advances = new Map(prior.advances ?? []);
    for (const [kind,count] of Object.entries(counts)) assert(Number.isInteger(count) && count >= 0 && count <= CAPS[kind], 'Invalid prior write count');
    assert(Object.keys(prior.counts ?? {}).every(k => Object.hasOwn(CAPS,k)), 'Unknown prior write category');
    assert.equal(used.size,(prior.keys ?? []).length,'Duplicate prior key');
    assert.equal(used.size,Object.values(counts).reduce((n,c)=>n+c,0),'Prior keys and counts disagree');
    assert.equal(advances.size,(prior.advances ?? []).length,'Duplicate prior clock count');
    for (const [id,count] of advances) assert(registry.clocks.has(id) && Number.isInteger(count) && count >= 0 && count <= (registry.clocks.get(id).label === 'F' ? 8 : 6), 'Invalid prior clock count');
    assert.equal([...advances.values()].reduce((n,c)=>n+c,0),counts.advance,'Prior clock advances disagree');
    return { ...provider, counts, request: async (method, path, params = {}, account, key, options) => {
        assert([undefined, D, E].includes(account), 'Account outside sandbox fixture');
        if (method === 'GET') return provider.request(method, path, params, account);
        assert.equal(method, 'POST'); assert.equal(account, D, 'Only D permits fixture writes');
        assert(typeof key === 'string' && !used.has(key), 'Repeated or missing sandbox write key');
        let kind;
        if (path === '/v1/test_helpers/test_clocks') {
            kind = 'clock'; keys(params, ['frozen_time', 'name']); assert.equal(params.frozen_time, start);
            assert([RUN+'-F', RUN+'-H'].includes(params.name)); assert(![...registry.clocks.values()].some(c => RUN+'-'+c.label === params.name), 'Clock label already exists');
        } else if (/^\/v1\/test_helpers\/test_clocks\/[^/]+\/advance$/.test(path)) {
            kind = 'advance'; keys(params, ['frozen_time']); const clock = registry.clocks.get(path.split('/')[4]); assert(clock, 'Unowned clock');
            assert(Number.isSafeInteger(params.frozen_time) && params.frozen_time > clock.time && params.frozen_time <= clock.time + 172800, 'Clock advance outside bound');
            const n = (advances.get(clock.id) ?? 0) + 1; assert(n <= (clock.label === 'F' ? 8 : 6), 'Clock advance count exceeded'); advances.set(clock.id, n);
        } else if (path === '/v1/customers') {
            kind = 'customer'; keys(params, ['name', 'test_clock', 'metadata[remold_fixture]']); assert(registry.clocks.has(params.test_clock));
            assert.equal(params['metadata[remold_fixture]'], RUN); assert.equal(params.name, 'Synthetic recurring '+registry.clocks.get(params.test_clock).label);
        } else if (path === '/v1/products') {
            kind = 'product'; keys(params, ['name', 'metadata[remold_fixture]']); assert.equal(params.name, 'Synthetic finite recurring service'); assert.equal(params['metadata[remold_fixture]'], RUN);
        } else if (path === '/v1/prices') {
            kind = 'price'; keys(params, ['product', 'currency', 'unit_amount', 'recurring[interval]', 'recurring[interval_count]', 'recurring[usage_type]', 'billing_scheme']);
            assert.equal(params.product, registry.product); assert(registry.product);
            assert.equal(params.currency, 'usd'); assert.equal(params.unit_amount, 301); assert.equal(params['recurring[interval]'], 'day'); assert.equal(params['recurring[interval_count]'], 1); assert.equal(params['recurring[usage_type]'], 'licensed'); assert.equal(params.billing_scheme, 'per_unit');
        } else if (path === '/v1/setup_intents') {
            kind = 'setup'; keys(params, ['customer', 'usage', 'payment_method', 'payment_method_types[0]', 'confirm']);
            assert(registry.customers.has(params.customer)); assert.equal(params.usage, 'off_session'); assert.equal(params.confirm, true); assert.equal(params['payment_method_types[0]'], 'card'); assert(['pm_card_visa', 'pm_card_chargeCustomerFail'].includes(params.payment_method));
        } else {
            const command = registry.commands.get(key); assert(command, 'Unregistered local recurring command'); kind = command.kind;
            assert(['activate', 'card', 'cancel'].includes(kind));
            if (kind === 'activate') {
                assert.equal(path, '/v1/subscription_schedules'); assert.equal(params.customer, command.customer); assert(registry.customers.has(params.customer));
                assert.equal(params['phases[0][items][0][price]'], registry.price); assert(registry.price);
                assert.equal(params['phases[0][iterations]'], 3); assert.equal(params['phases[0][items][0][quantity]'], 1); assert.equal(params.end_behavior, 'cancel');
                assert.equal(params.start_date, command.start); assert.equal(params['metadata[remold_commitment]'], command.commitment); assert.equal(params['metadata[remold_plan]'], command.planHash);
                assert.equal(params['default_settings[collection_method]'], 'charge_automatically'); assert.equal(params['phases[0][collection_method]'], 'charge_automatically'); assert.equal(params['default_settings[automatic_tax][enabled]'], false); assert.equal(params['phases[0][automatic_tax][enabled]'], false); assert.equal(params['phases[0][proration_behavior]'], 'none');
                assert(registry.paymentMethods.has(params['default_settings[default_payment_method]']));
                keys(params, ['customer','start_date','end_behavior','default_settings[collection_method]','default_settings[default_payment_method]','default_settings[automatic_tax][enabled]','phases[0][collection_method]','phases[0][automatic_tax][enabled]','phases[0][items][0][price]','phases[0][items][0][quantity]','phases[0][iterations]','phases[0][proration_behavior]','metadata[remold_commitment]','metadata[remold_plan]']);
            } else if (kind === 'card') {
                assert.equal(path, '/v1/subscriptions/' + command.subscription); assert(registry.subscriptions.has(command.subscription)); keys(params, ['default_payment_method']); assert(registry.paymentMethods.has(params.default_payment_method));
            } else {
                assert.equal(path, '/v1/subscription_schedules/' + command.schedule + '/cancel'); assert(registry.schedules.has(command.schedule)); keys(params, ['invoice_now', 'prorate']); assert.equal(params.invoice_now, false); assert.equal(params.prorate, false);
            }
        }
        if (kind !== 'activate') assert(!options?.loseResponse, 'Response loss is activation-only');
        assert(counts[kind] < CAPS[kind], 'Sandbox write cap exceeded'); counts[kind]++; used.add(key);
        return provider.request(method, path, params, account, key, options);
    }};
}
