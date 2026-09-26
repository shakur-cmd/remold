import assert from 'node:assert/strict';
import { makeFunctionReference } from 'convex/server';
import { proveNoPlatformFee } from '../invoice-contract.mjs';
import { cadence } from './cadence.ts';
import { assertSameInvoice } from './provider-evidence.mjs';
export const termEnd = plan => cadence(plan, 3);
const id = x => typeof x === 'string' ? x : x?.id;
export function recurringAdapter(stripe, client, token) {
    const m = (n, a) => client.mutation(makeFunctionReference('recurring:' + n), { token, ...a }), q = (n, a) => client.query(makeFunctionReference('recurring:' + n), { token, ...a });
    const list = async (path, params, account) => {
        const r = await stripe.request('GET', path, { ...params, limit: 100 }, account);
        assert.equal(r.has_more, false, 'Incomplete recurring inventory');
        assert.ok(Array.isArray(r.data) && r.data.length <= 100);
        assert.equal(new Set(r.data.map(x => x.id)).size, r.data.length);
        return r.data;
    };
    const contains = (rows, ids) => ids.every(known => rows.some(row => row.id === known));
    const clock = (object, c) => assert.equal(object.test_clock, c.plan.testClock ?? null, 'Recurring clock binding changed');
    async function customerIdentity(c) {
        const customer = await stripe.request('GET', '/v1/customers/' + c.customer.externalId, {}, c.account);
        assert.equal(customer.id, c.customer.externalId);
        assert.equal(customer.livemode, false);
        clock(customer, c);
        return customer;
    }
    function lineage(schedule, sub, c) {
        assert.equal(schedule.id, c.commitment.schedule ?? schedule.id);
        assert.equal(sub.id, c.commitment.subscription ?? sub.id);
        for (const object of [schedule, sub]) {
            assert.equal(object.customer, c.customer.externalId);
            assert.equal(object.livemode, false);
            clock(object, c);
        }
        const terminal = Boolean(c.commitment.schedule && ['canceled', 'completed'].includes(schedule.status) && sub.status === 'canceled');
        assert.equal(schedule.released_subscription, null);
        // Cleared links are valid only after both exact, previously bound objects terminate.
        if (!(terminal && schedule.subscription === null)) assert.equal(id(schedule.subscription), sub.id);
        if (!(terminal && sub.schedule === null)) assert.equal(id(sub.schedule), schedule.id);
        return terminal;
    }
    const shape = (s, c) => {
        assert.equal(s.livemode, false);
        clock(s, c);
        assert.equal(s.customer, c.customer.externalId);
        assert.equal(s.metadata?.remold_commitment, c.commitment._id);
        assert.equal(s.end_behavior, 'cancel');
        assert.ok(['not_started', 'active', 'canceled', 'completed'].includes(s.status), 'Unsupported schedule state');
        assert.equal(s.phases.length, 1);
        const phase = s.phases[0];
        assert.equal(phase.start_date, c.plan.start);
        assert.equal(phase.end_date, termEnd(c.plan));
        assert.equal(phase.items.length, 1);
        assert.equal(id(phase.items[0].price), c.plan.price);
        assert.equal(phase.items[0].quantity, 1);
        for (const object of [s.default_settings, phase]) {
            assert.equal(object.collection_method, 'charge_automatically');
            for (const key of ['application_fee_percent', 'transfer_data', 'on_behalf_of'])
                assert.ok(object[key] == null, 'Fee/transfer unsupported');
            assert.equal(object.automatic_tax?.enabled, false);
            assert.deepEqual(object.default_tax_rates ?? [], []);
            assert.deepEqual(object.discounts ?? [], []);
        }
        assert.equal(phase.proration_behavior, 'none');
        return s;
    };
    function subscriptionItem(sub, c) {
        assert.equal(sub.customer, c.customer.externalId);
        assert.equal(sub.livemode, false);
        clock(sub, c);
        assert.equal(sub.items?.has_more, false);
        assert.equal(sub.items.data.length, 1);
        const item = sub.items.data[0];
        assert.ok(typeof item.id === 'string' && item.id.startsWith('si_'));
        assert.equal(id(item.price), c.plan.price);
        assert.equal(item.quantity, 1);
        return item.id;
    }
    function invoiceLine(invoice, c) {
        const complete = invoice.lines?.has_more === false && Array.isArray(invoice.lines.data);
        const raw = complete && invoice.lines.data.length === 1 ? invoice.lines.data[0] : null;
        const parent = raw?.parent?.subscription_item_details;
        let line = null;
        if (raw 
            && typeof raw.id === 'string' 
            && typeof parent?.subscription_item === 'string' 
            && typeof raw.pricing?.price_details?.price === 'string' 
            && Number.isSafeInteger(raw.period?.start) 
            && Number.isSafeInteger(raw.period?.end))
            line = {
                id: raw.id,
                subscriptionItem: parent.subscription_item,
                price: raw.pricing.price_details.price,
                serviceStart: raw.period.start,
                serviceEnd: raw.period.end
            };
        const empty = value => value == null || (Array.isArray(value) && value.length === 0);
        const valid = Boolean(line 
            && raw.invoice === invoice.id 
            && raw.livemode === false 
            && raw.currency === 'usd' 
            && raw.amount === 301 
            && raw.quantity === 1 
            && raw.parent.type === 'subscription_item_details' 
            && parent.proration === false 
            && parent.invoice_item === null 
            && parent.subscription === c.commitment.subscription 
            && (raw.subscription == null 
            || id(raw.subscription) === c.commitment.subscription) 
            && line.subscriptionItem === c.commitment.subscriptionItem 
            && raw.pricing.type === 'price_details' 
            && line.price === c.plan.price 
            && empty(raw.discount_amounts) 
            && empty(raw.taxes) 
            && empty(raw.pretax_credit_amounts) 
            && invoice.subtotal === 301 
            && invoice.total === 301 
            && invoice.amount_due === 301);
        return {
            lineComplete: complete,
            lineShape: valid,
            line,
            billingReason: typeof invoice.billing_reason === 'string' ? invoice.billing_reason : ''
        };
    }
    async function setup(c, setupIntent) {
        const s = await stripe.request('GET', '/v1/setup_intents/' + setupIntent, {}, c.account);
        assert.equal(s.id, setupIntent);
        assert.equal(s.livemode, false);
        assert.equal(s.customer, c.customer.externalId);
        assert.equal(s.status, 'succeeded');
        assert.equal(s.usage, 'off_session');
        assert.ok(typeof s.payment_method === 'string');
        const pm = await stripe.request('GET', '/v1/payment_methods/' + s.payment_method, {}, c.account);
        assert.equal(pm.id, s.payment_method);
        assert.equal(pm.livemode, false);
        assert.equal(pm.customer, c.customer.externalId);
        assert.equal(pm.type, 'card');
        return pm.id;
    }
    async function preflight(c) {
        const account = await stripe.request('GET', '/v1/accounts/' + c.account);
        assert.equal(account.id, c.account);
        assert.equal(account.charges_enabled, true);
        assert.equal(account.capabilities?.card_payments, 'active');
        assert.equal(account.requirements?.disabled_reason, null);
        for (const field of ['currently_due', 'past_due', 'pending_verification', 'errors'])
            assert.deepEqual(account.requirements[field], []);
        const customer = await customerIdentity(c);
        assert.equal(customer.balance, 0);
        const cash = await stripe.request('GET', '/v1/customers/' + customer.id + '/cash_balance', {}, c.account);
        assert.equal(cash.customer, customer.id);
        assert.ok(cash.available == null || Object.keys(cash.available).length === 0);
        assert.deepEqual(await list('/v1/invoiceitems', { customer: customer.id, pending: true }, c.account), []);
        const price = await stripe.request('GET', '/v1/prices/' + c.plan.price, {}, c.account);
        assert.equal(price.id, c.plan.price);
        assert.equal(price.livemode, false);
        assert.equal(price.active, true);
        assert.equal(price.unit_amount, 301);
        assert.equal(price.currency, 'usd');
        assert.equal(price.billing_scheme, 'per_unit');
        assert.equal(price.recurring.interval, c.plan.interval);
        assert.equal(price.recurring.interval_count, 1);
        assert.equal(price.recurring.usage_type, 'licensed');
        assert.ok(!price.transform_quantity && !price.tiers_mode);
    }
    async function execute(commandId, { beforePermit, afterPermit } = {}) {
        const cmd = await q('command', { id: commandId }), c = await q('context', { id: cmd.commitment });
        let params, path, method = 'POST';
        if (cmd.kind === 'activate') {
            await preflight(c);
            const schedules = await list('/v1/subscription_schedules', { customer: c.customer.externalId }, c.account);
            assert(contains(schedules, c.providerHistory.flatMap(row => row.schedule ? [row.schedule] : [])), 'Known schedule missing before activation');
            assert.ok(schedules.every(s => ['canceled', 'completed'].includes(s.status)), 'Existing nonterminal provider commitment');
            const subscriptions = await list('/v1/subscriptions', { customer: c.customer.externalId, status: 'all' }, c.account);
            assert(contains(subscriptions, c.providerHistory.flatMap(row => row.subscription ? [row.subscription] : [])), 'Known subscription missing before activation');
            assert.ok(subscriptions.every(s => s.status === 'canceled'), 'Existing subscription');
            const pm = await setup(c, c.plan.setupIntent);
            params = {
                customer: c.customer.externalId,
                start_date: c.plan.start,
                end_behavior: 'cancel',
                'default_settings[collection_method]': 'charge_automatically',
                'default_settings[default_payment_method]': pm,
                'default_settings[automatic_tax][enabled]': false,
                'phases[0][collection_method]': 'charge_automatically',
                'phases[0][automatic_tax][enabled]': false,
                'phases[0][items][0][price]': c.plan.price,
                'phases[0][items][0][quantity]': 1,
                'phases[0][iterations]': 3,
                'phases[0][proration_behavior]': 'none',
                'metadata[remold_commitment]': c.commitment._id,
                'metadata[remold_plan]': c.plan.hash
            };
            path = '/v1/subscription_schedules';
        }
        else if (cmd.kind === 'card') {
            await customerIdentity(c);
            assert.ok(c.commitment.subscription);
            const s = await stripe.request('GET', '/v1/subscription_schedules/' + c.commitment.schedule, {}, c.account);
            shape(s, c);
            assert.equal(s.status, 'active');
            const sub = await stripe.request('GET', '/v1/subscriptions/' + c.commitment.subscription, {}, c.account);
            lineage(s, sub, c);
            assert.equal(subscriptionItem(sub, c), c.commitment.subscriptionItem);
            assert.ok(!['canceled', 'incomplete_expired'].includes(sub.status));
            params = { default_payment_method: await setup(c, cmd.setupIntent) };
            path = '/v1/subscriptions/' + sub.id;
        }
        else {
            assert.equal(cmd.kind, 'cancel');
            await customerIdentity(c);
            const schedule = await stripe.request('GET', '/v1/subscription_schedules/' + c.commitment.schedule, {}, c.account);
            const sub = await stripe.request('GET', '/v1/subscriptions/' + c.commitment.subscription, {}, c.account);
            lineage(schedule, sub, c);
            assert.equal(schedule.status, 'active');
            assert.equal(subscriptionItem(sub, c), c.commitment.subscriptionItem);
            params = { invoice_now: false, prorate: false };
            path = '/v1/subscription_schedules/' + schedule.id + '/cancel';
        }
        await beforePermit?.();
        const permit = await m('consume', { id: commandId });
        assert.equal(permit.account, c.account);
        assert.equal(permit.kind, cmd.kind);
        await afterPermit?.();
        try {
            const result = await stripe.request(method, path, params, c.account, permit.key);
            await record(cmd, c, result, params);
            return result;
        }
        catch (error) {
            await m('unknown', { id: commandId });
            throw error;
        }
    }
    async function record(cmd, c, result, params) {
        await customerIdentity(c);
        clock(result, c);
        if (cmd.kind === 'activate') {
            shape(result, c);
            assert.equal(result.status, 'active');
            assert.equal(result.metadata.remold_plan, c.plan.hash);
            assert.equal(typeof result.subscription, 'string');
            const sub = await stripe.request('GET', '/v1/subscriptions/' + result.subscription, {}, c.account);
            assert.equal(sub.id, result.subscription);
            lineage(result, sub, c);
            const item = subscriptionItem(sub, c);
            await m('settled', {
                id: cmd._id,
                providerRef: result.id,
                subscription: result.subscription,
                subscriptionItem: item,
                providerEnd: termEnd(c.plan)
            });
        }
        else {
            assert.equal(result.id, cmd.kind === 'cancel' ? c.commitment.schedule : c.commitment.subscription);
            assert.equal(result.livemode, false);
            assert.equal(result.customer, c.customer.externalId);
            if (cmd.kind === 'cancel')
                assert.equal(result.status, 'canceled');
            else
                assert.equal(result.default_payment_method, params.default_payment_method);
            await m('settled', { id: cmd._id, providerRef: result.id });
        }
    }
    async function reconcileActivation(commandId) {
        const cmd = await q('command', { id: commandId });
        assert.equal(cmd.kind, 'activate');
        assert.ok(['consumed', 'unknown'].includes(cmd.state));
        const c = await q('context', { id: cmd.commitment }), rows = await list('/v1/subscription_schedules', { customer: c.customer.externalId }, c.account), matching = rows.filter(s => s.metadata?.remold_commitment === c.commitment._id);
        assert.equal(matching.length, 1, 'Activation remains unknown');
        const s = await stripe.request('GET', '/v1/subscription_schedules/' + matching[0].id, {}, c.account);
        await record(cmd, c, s);
        return s.id;
    }
    async function observe(commitmentId) {
        const generation = await m('beginObservation', { id: commitmentId }), c = await q('context', { id: commitmentId });
        const schedule = await stripe.request('GET', '/v1/subscription_schedules/' + c.commitment.schedule, {}, c.account), subscription = await stripe.request('GET', '/v1/subscriptions/' + c.commitment.subscription, {}, c.account);
        assert.equal(schedule.id, c.commitment.schedule);
        assert.equal(subscription.id, c.commitment.subscription);
        await customerIdentity(c);
        const terminal = lineage(schedule, subscription, c);
        let shapeValid = contains(await list('/v1/subscription_schedules', { customer: c.customer.externalId }, c.account), [schedule.id]);
        shapeValid = contains(await list('/v1/subscriptions', { customer: c.customer.externalId, status: 'all' }, c.account), [subscription.id]) && shapeValid;
        try {
            shape(schedule, c);
            assert.equal(subscriptionItem(subscription, c), c.commitment.subscriptionItem);
        }
        catch {
            shapeValid = false;
        }
        const rows = await list('/v1/invoices', { customer: c.customer.externalId, subscription: subscription.id }, c.account);
        assert.ok(rows.length <= 10);
        shapeValid = contains(rows, c.cycles.map(row => row.invoice)) && shapeValid;
        const cycles = [];
        for (const row of rows) {
            const invoice = await stripe.request('GET', '/v1/invoices/' + row.id, {}, c.account);
            assert.equal(invoice.id, row.id);
            assert.equal(invoice.customer, c.customer.externalId);
            assert.equal(invoice.livemode, false);
            assert.equal(invoice.currency, 'usd');
            assert.equal(invoice.parent?.subscription_details?.subscription, subscription.id);
            const paymentRows = await list('/v1/invoice_payments', { invoice: invoice.id }, c.account), payments = [];
            shapeValid = contains(paymentRows, (c.cycles.find(row => row.invoice === invoice.id)?.payments ?? []).flatMap(p => p.invoicePayment ? [p.invoicePayment] : [])) && shapeValid;
            for (const listed of paymentRows) {
                const payment = await stripe.request('GET', '/v1/invoice_payments/' + listed.id, {}, c.account);
                assert.equal(payment.id, listed.id);
                assert.equal(payment.invoice, invoice.id);
                assert.equal(payment.livemode, false);
                assert.equal(payment.currency, 'usd');
                assert.equal(payment.payment?.type, 'payment_intent');
                const pi = await stripe.request('GET', '/v1/payment_intents/' + payment.payment.payment_intent, {}, c.account);
                assert.equal(pi.id, payment.payment.payment_intent);
                assert.equal(pi.customer, c.customer.externalId);
                assert.equal(pi.livemode, false);
                assert.equal(pi.currency, 'usd');
                assert.ok(Number.isSafeInteger(pi.amount) && pi.amount >= 0);
                let status = pi.status === 'succeeded' ? 'succeeded' : pi.status === 'canceled' ? 'cancelled' : pi.status === 'requires_payment_method' ? 'failed' : 'pending';
                if (status === 'succeeded') {
                    assert.equal(payment.status, 'paid');
                    assert.equal(payment.amount_paid, pi.amount_received);
                    await proveNoPlatformFee(stripe, {
                        paymentIntent: pi.id,
                        account: c.account,
                        customer: c.customer.externalId,
                        amountMinor: pi.amount_received
                    });
                }
                else
                    assert.ok(['open', 'canceled'].includes(payment.status));
                payments.push({
                    id: pi.id,
                    invoicePayment: payment.id,
                    amountMinor: status === 'succeeded' ? pi.amount_received : pi.amount,
                    status
                });
            }
            const final = await stripe.request('GET', '/v1/invoices/' + invoice.id, {}, c.account);
            assertSameInvoice(invoice, final);
            cycles.push({
                ...invoiceLine(invoice, c),
                invoice: invoice.id,
                subscription: subscription.id,
                period: invoice.period_start,
                amountMinor: invoice.amount_due,
                paidMinor: invoice.amount_paid,
                status: invoice.status,
                autoAdvance: invoice.auto_advance,
                payments
            });
        }
        const last = await stripe.request('GET', '/v1/subscription_schedules/' + schedule.id, {}, c.account);
        assert.deepEqual(last, schedule, 'Schedule changed during traversal');
        const lastSub = await stripe.request('GET', '/v1/subscriptions/' + subscription.id, {}, c.account);
        assert.deepEqual(lastSub, subscription, 'Subscription changed during traversal');
        const pending = await list('/v1/invoiceitems', { customer: c.customer.externalId, pending: true }, c.account);
        return m('observe', {
            id: commitmentId,
            generation,
            subscription: subscription.id,
            schedule: schedule.id,
            terminal,
            cancelled: schedule.status === 'canceled',
            shapeValid,
            pendingItemsEmpty: pending.length === 0,
            cycles
        });
    }
    async function reconcileCommand(commandId) {
        const cmd = await q('command', { id: commandId });
        assert.ok(['consumed', 'unknown'].includes(cmd.state));
        if (cmd.kind === 'activate')
            return reconcileActivation(commandId);
        const c = await q('context', { id: cmd.commitment });
        const result = await stripe.request('GET', cmd.kind === 'cancel' ? '/v1/subscription_schedules/' + c.commitment.schedule : '/v1/subscriptions/' + c.commitment.subscription, {}, c.account);
        await record(cmd, c, result, cmd.kind === 'card' ? { default_payment_method: await setup(c, cmd.setupIntent) } : {});
        return result.id;
    }
    return {
        execute,
        reconcileActivation,
        reconcileCommand,
        observe
    };
}
