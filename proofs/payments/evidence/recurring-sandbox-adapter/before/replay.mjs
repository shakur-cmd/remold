import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { withRecurring } from './local.mjs';
import { recurringAdapter, termEnd } from './adapter.mjs';
const results = [], secrets = [];
try {
    await withRecurring(async ({ url, run, restart }) => {
        const client = new ConvexHttpClient(url, { logger: false }), m = (name, args) => client.mutation(makeFunctionReference(name), args), q = (name, args) => client.query(makeFunctionReference(name), args), tokens = Array.from({ length: 10 }, () => randomUUID());
        secrets.push(...tokens);
        const f = run('harness:seed', { run: randomUUID(), tokens }), who = f.A.sessions.owner;
        for (const name of ['A', 'B'])
            run('paymentFixture:role', { actor: f[name].actors.owner, role: 'finance' });
        const customers = new Map(), schedules = new Map(), subs = new Map(), invoices = new Map(), pis = new Map(), charges = new Map(), setups = new Map(), pms = new Map(), payments = new Map(), posts = [];
        let counter = 0, lose = false, dirtyItems = false, badPrice = false, unknownSchedule = false, invoiceDrift = false, invoiceReads = 0;
        const start = Math.floor(Date.now() / 1000), phase = (params) => ({
            start_date: Number(params.start_date),
            end_date: termEnd({ start: Number(params.start_date), interval: 'day' }),
            items: [{ price: params['phases[0][items][0][price]'], quantity: 1 }],
            collection_method: 'charge_automatically',
            automatic_tax: { enabled: false },
            proration_behavior: 'none'
        });
        const server = createServer(async (req, res) => {
            try {
                const u = new URL(req.url, 'http://localhost'), account = req.headers['stripe-account'];
                let body = '';
                for await (const b of req)
                    body += b;
                const params = Object.fromEntries(new URLSearchParams(body));
                let value;
                if (req.method === 'POST') {
                    posts.push({
                        path: u.pathname,
                        params,
                        key: req.headers['idempotency-key'],
                        account
                    });
                    if (u.pathname === '/v1/subscription_schedules') {
                        const id = 'sub_sched_' + (++counter), sub = 'sub_' + counter;
                        value = {
                            id,
                            subscription: sub,
                            customer: params.customer,
                            livemode: false,
                            status: 'active',
                            metadata: { remold_commitment: params['metadata[remold_commitment]'], remold_plan: params['metadata[remold_plan]'] },
                            end_behavior: params.end_behavior,
                            default_settings: { collection_method: 'charge_automatically', automatic_tax: { enabled: false } },
                            phases: [phase(params)]
                        };
                        schedules.set(id, value);
                        subs.set(sub, {
                            id: sub,
                            schedule: id,
                            customer: params.customer,
                            livemode: false,
                            status: 'active',
                            default_payment_method: params['default_settings[default_payment_method]'],
                            items: { has_more: false, data: [{
                                        id: 'si_' + counter,
                                        price: { id: params['phases[0][items][0][price]'] },
                                        quantity: 1
                                    }] }
                        });
                    }
                    else if (u.pathname.endsWith('/cancel')) {
                        value = schedules.get(u.pathname.split('/')[3]);
                        value.status = 'canceled';
                        subs.get(value.subscription).status = 'canceled';
                        for (const invoice of invoices.values())
                            if (invoice.parent.subscription_details.subscription === value.subscription)
                                invoice.auto_advance = false;
                    }
                    else if (u.pathname.startsWith('/v1/subscriptions/')) {
                        value = subs.get(u.pathname.split('/')[3]);
                        value.default_payment_method = params.default_payment_method;
                    }
                    else
                        throw Error('Unexpected provider write');
                    if (lose) {
                        lose = false;
                        req.socket.destroy();
                        return;
                    }
                }
                else if (u.pathname.startsWith('/v1/accounts/'))
                    value = {
                        id: u.pathname.split('/')[3],
                        charges_enabled: true,
                        capabilities: { card_payments: 'active' },
                        requirements: {
                            disabled_reason: null,
                            currently_due: [],
                            past_due: [],
                            pending_verification: [],
                            errors: []
                        }
                    };
                else if (u.pathname.endsWith('/cash_balance'))
                    value = {
                        customer: u.pathname.split('/')[3],
                        livemode: false,
                        available: null
                    };
                else if (u.pathname.startsWith('/v1/customers/'))
                    value = customers.get(u.pathname.split('/')[3]);
                else if (u.pathname.startsWith('/v1/prices/'))
                    value = {
                        id: u.pathname.split('/')[3],
                        livemode: false,
                        active: true,
                        unit_amount: badPrice ? 302 : 301,
                        currency: 'usd',
                        billing_scheme: 'per_unit',
                        recurring: {
                            interval: 'day',
                            interval_count: 1,
                            usage_type: 'licensed'
                        }
                    };
                else if (u.pathname === '/v1/invoiceitems')
                    value = { has_more: false, data: dirtyItems ? [{ id: 'ii_pending' }] : [] };
                else if (u.pathname === '/v1/application_fees') {
                    assert.equal(account, undefined);
                    value = { has_more: false, data: [] };
                }
                else if (u.pathname === '/v1/subscription_schedules')
                    value = { has_more: unknownSchedule, data: [...schedules.values()].filter(x => x.customer === u.searchParams.get('customer')) };
                else if (u.pathname === '/v1/subscriptions')
                    value = { has_more: false, data: [...subs.values()].filter(x => x.customer === u.searchParams.get('customer')) };
                else if (u.pathname === '/v1/invoices')
                    value = { has_more: false, data: [...invoices.values()].filter(x => x.customer === u.searchParams.get('customer') 
                        && x.parent.subscription_details.subscription === u.searchParams.get('subscription')) };
                else if (u.pathname === '/v1/invoice_payments')
                    value = { has_more: false, data: [...payments.values()].filter(x => x.invoice === u.searchParams.get('invoice')) };
                else {
                    const maps = {
                        subscription_schedules: schedules,
                        subscriptions: subs,
                        invoices,
                        invoice_payments: payments,
                        payment_intents: pis,
                        charges,
                        setup_intents: setups,
                        payment_methods: pms
                    };
                    value = maps[u.pathname.split('/')[2]]?.get(u.pathname.split('/')[3]);
                }
                if (!value)
                    throw Error('Missing loopback object');
                if (invoiceDrift && req.method === 'GET' && u.pathname.startsWith('/v1/invoices/')) {
                    invoiceReads++;
                    if (invoiceReads === 2)
                        value = { ...value, currency: 'eur' };
                }
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(value));
            }
            catch {
                res.writeHead(400).end('{"error":"synthetic refusal"}');
            }
        });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        const stripe = { request: async (method, path, params = {}, account, key) => {
                const u = new URL(path, 'http://127.0.0.1:' + server.address().port);
                if (method === 'GET')
                    u.search = new URLSearchParams(params);
                const response = await fetch(u, {
                    method,
                    headers: { ...(account ? { 'Stripe-Account': account } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
                    ...(method === 'POST' ? { body: new URLSearchParams(params) } : {})
                });
                if (response.status !== 200)
                    throw Error('Loopback provider refusal');
                return response.json();
            } };
        const adapter = recurringAdapter(stripe, client, f.A.adapter), inspect = id => q('recurring:inspect', { token: who, id });
        async function plan({ author = who, service = randomUUID(), begin = start, customer, setup = 'seti_' + randomUUID() } = {}) {
            if (!customer) {
                const external = 'cus_' + randomUUID();
                customers.set(external, {
                    id: external,
                    livemode: false,
                    balance: 0
                });
                customer = await m('payments:registerCustomer', {
                    token: f.A.adapter,
                    binding: f.A.binding,
                    externalId: external,
                    name: 'Synthetic recurring customer'
                });
            }
            const dbCustomer = run('recurringFixture:customer', { id: customer });
            const pm = 'pm_' + randomUUID();
            pms.set(pm, {
                id: pm,
                customer: dbCustomer.externalId,
                livemode: false,
                type: 'card'
            });
            setups.set(setup, {
                id: setup,
                customer: dbCustomer.externalId,
                livemode: false,
                status: 'succeeded',
                usage: 'off_session',
                payment_method: pm
            });
            const args = {
                token: author,
                customer,
                service,
                price: 'price_fixture',
                setupIntent: setup,
                interval: 'day',
                start: begin,
                amountMinor: 301,
                cycles: 3,
                currency: 'usd'
            }, id = await m('recurring:propose', args), acceptance = await client.action(makeFunctionReference('recurring:issueAcceptance'), { token: who, plan: id });
            secrets.push(acceptance.token);
            return {
                id,
                acceptance,
                args,
                customer: dbCustomer
            };
        }
        const accept = async (p) => m('recurring:accept', { plan: p.id, ...p.acceptance });
        async function agreement(options) {
            const p = await plan(options);
            await accept(p);
            const a = await m('recurring:adopt', { token: who, plan: p.id });
            return { ...a, p };
        }
        const cycle = (a, n, { status = 'paid', paymentStatus = 'succeeded', amount = 301, paid = paymentStatus === 'succeeded' ? amount : 0 } = {}) => {
            const schedule = [...schedules.values()].find(s => s.metadata.remold_commitment === a.id), invoice = 'in_' + a.id + '_' + n, pi = 'pi_' + invoice, ip = 'inpay_' + invoice, ch = 'ch_' + pi;
            invoices.set(invoice, {
                id: invoice,
                customer: schedule.customer,
                livemode: false,
                currency: 'usd',
                parent: { subscription_details: { subscription: schedule.subscription } },
                period_start: a.p.args.start + (n - 1) * 86400,
                period_end: a.p.args.start + n * 86400,
                billing_reason: n === 0 ? 'subscription_create' : 'subscription_cycle',
                subtotal: amount,
                total: amount,
                lines: { has_more: false, data: [{
                            id: 'il_' + invoice,
                            invoice,
                            livemode: false,
                            currency: 'usd',
                            amount,
                            quantity: 1,
                            subscription: schedule.subscription,
                            parent: { type: 'subscription_item_details', subscription_item_details: {
                                    subscription: schedule.subscription,
                                    subscription_item: subs.get(schedule.subscription).items.data[0].id,
                                    proration: false,
                                    invoice_item: null
                                } },
                            pricing: { type: 'price_details', price_details: { price: a.p.args.price } },
                            period: { start: a.p.args.start + n * 86400, end: a.p.args.start + (n + 1) * 86400 },
                            discount_amounts: [],
                            taxes: [],
                            pretax_credit_amounts: []
                        }] },
                amount_due: amount,
                amount_paid: paid,
                status,
                auto_advance: status === 'open'
            });
            pis.set(pi, {
                id: pi,
                customer: schedule.customer,
                livemode: false,
                currency: 'usd',
                amount,
                amount_received: paid,
                status: paymentStatus,
                latest_charge: paymentStatus === 'succeeded' ? ch : null,
                application_fee_amount: null,
                transfer_data: null,
                on_behalf_of: null
            });
            payments.set(ip, {
                id: ip,
                invoice,
                livemode: false,
                currency: 'usd',
                status: paymentStatus === 'succeeded' ? 'paid' : paymentStatus === 'canceled' ? 'canceled' : 'open',
                amount_paid: paid,
                payment: { type: 'payment_intent', payment_intent: pi }
            });
            charges.set(ch, {
                id: ch,
                payment_intent: pi,
                customer: schedule.customer,
                livemode: false,
                currency: 'usd',
                amount,
                paid: true,
                application_fee: null,
                application_fee_amount: null,
                transfer_data: null,
                on_behalf_of: null
            });
            return { invoice, pi };
        };
        try {
            const raw = await plan({ author: f.A.sessions.child });
            await assert.rejects(m('recurring:accept', {
                plan: raw.id,
                token: raw.acceptance.token + 'x',
                hash: raw.acceptance.hash
            }), /invalid acceptance/);
            await assert.rejects(m('recurring:accept', {
                plan: raw.id,
                token: raw.acceptance.token,
                hash: 'changed'
            }), /invalid acceptance/);
            await accept(raw);
            await accept(raw);
            await assert.rejects(m('recurring:adopt', { token: f.A.sessions.child, plan: raw.id }), /human finance/);
            await assert.rejects(m('recurring:adopt', { token: f.B.sessions.owner, plan: raw.id }), /tenant denied/);
            await assert.rejects(m('recurring:propose', { ...raw.args, cycles: 4 }));
            await m('harness:grant', {
                token: who,
                target: f.A.actors.child,
                capability: 'billing.collect',
                scope: {
                    kind: 'bindings',
                    bindings: [f.A.binding],
                    maxAmountMinor: 903,
                    currency: 'usd',
                    maxRecipients: 1
                },
                mode: 'direct',
                delegate: false,
                expires: Date.now() + 60000
            });
            await assert.rejects(m('recurring:adopt', { token: f.A.sessions.child, plan: raw.id }), /human finance/);
            const raced = await Promise.allSettled([1, 2].map(() => m('recurring:adopt', { token: who, plan: raw.id })));
            assert.equal(raced.filter(x => x.status === 'fulfilled').length, 1);
            const a = { ...raced.find(x => x.status === 'fulfilled').value, p: raw };
            const adopted = await inspect(a.id);
            assert.equal(adopted.commitment.reservedMinor, 903);
            assert.equal(adopted.commitment.actor, f.A.actors.owner);
            assert.equal(adopted.commitment.author, f.A.actors.child);
            assert.notEqual(adopted.commitment.actor, adopted.commitment.author);
            results.push('Accepted immutable terms, human adoption, tenant scope, agent direct-grant refusal and concurrent903 reservation');
            await m('harness:revoke', { token: who, target: f.A.actors.child });
            await adapter.execute(a.command);
            assert.equal(posts.length, 1);
            assert.equal(posts[0].params['phases[0][iterations]'], '3');
            assert.equal(posts[0].params.end_behavior, 'cancel');
            await assert.rejects(adapter.execute(a.command), /Existing nonterminal|consumed/);
            await assert.rejects(q('recurring:inspect', { token: f.B.sessions.owner, id: a.id }), /tenant denied/);
            await assert.rejects(recurringAdapter(stripe, client, f.B.adapter).observe(a.id), /adapter account/);
            results.push('New human commitment survives original agent firing; one closed activation and no generic replay');
            const first = cycle(a, 0);
            await adapter.observe(a.id);
            let state = await inspect(a.id);
            assert.equal(state.commitment.paidMinor, 301);
            assert.equal(state.commitment.reservedMinor, 602);
            await adapter.observe(a.id);
            assert.equal((await inspect(a.id)).commitment.paidMinor, 301);
            await restart();
            assert.equal((await inspect(a.id)).commitment.reservedMinor, 602);
            await m('harness:control', { token: who, readonly: true });
            cycle(a, 1, { status: 'open', paymentStatus: 'requires_payment_method' });
            await adapter.observe(a.id);
            assert.equal((await inspect(a.id)).cycles.length, 2);
            await assert.rejects(m('recurring:prepareCommand', {
                token: who,
                id: a.id,
                kind: 'card',
                setupIntent: raw.args.setupIntent
            }), /readonly/);
            await m('harness:control', { token: who, readonly: false });
            results.push('Real backend restart preserves commitment; provider failed renewal and readonly observations retain exposure');
            const next = await plan({ customer: raw.customer._id, service: raw.args.service });
            await accept(next);
            await assert.rejects(m('recurring:adopt', { token: who, plan: next.id }), /prior commitment/);
            const card = await m('recurring:prepareCommand', {
                token: who,
                id: a.id,
                kind: 'card',
                setupIntent: next.args.setupIntent
            });
            await adapter.execute(card);
            cycle(a, 1);
            await adapter.observe(a.id);
            assert.equal((await inspect(a.id)).commitment.paidMinor, 602);
            results.push('Bound card change and same-invoice retry observed once; no manual invoice-pay request');
            cycle(a, 2);
            await adapter.observe(a.id);
            const s = [...schedules.values()].find(x => x.metadata.remold_commitment === a.id);
            s.status = 'completed';
            subs.get(s.subscription).status = 'canceled';
            await adapter.observe(a.id);
            state = await inspect(a.id);
            assert.equal(state.commitment.state, 'ended');
            assert.equal(state.commitment.paidMinor, 903);
            assert.equal(state.commitment.reservedMinor, 0);
            await assert.rejects(m('recurring:adopt', { token: who, plan: next.id }), /replacement overlap/);
            const replacement = await agreement({
                customer: raw.customer._id,
                service: raw.args.service,
                begin: termEnd(raw.args)
            });
            await adapter.execute(replacement.command);
            await adapter.observe(a.id);
            assert.equal((await inspect(replacement.id)).commitment.paidMinor, 0);
            results.push('Three cycles settle903; replacement requires new accepted version/nonoverlap and old observation leaves new generation unchanged');
            const lost = await agreement();
            lose = true;
            await assert.rejects(adapter.execute(lost.command));
            assert.equal((await inspect(lost.id)).commitment.reservedMinor, 903);
            assert.equal((await inspect(lost.id)).commitment.state, 'outcomeUnknown');
            const count = posts.length;
            let cancellationError = false;
            try {
                await m('recurring:prepareCommand', {
                    token: who,
                    id: lost.id,
                    kind: 'cancel'
                });
            }
            catch {
                cancellationError = true;
            }
            const pendingLost = await inspect(lost.id);
            assert.deepEqual({
                cancellationError,
                requested: pendingLost.commitment.cancelRequested,
                state: pendingLost.commitment.state,
                held: pendingLost.commitment.reservedMinor
            }, {
                cancellationError: false,
                requested: true,
                state: 'cancellationPending',
                held: 903
            }, 'Unknown activation must retain human cancellation intent');
            unknownSchedule = true;
            await assert.rejects(adapter.reconcileActivation(lost.command), /Incomplete/);
            unknownSchedule = false;
            await restart();
            await adapter.reconcileActivation(lost.command);
            assert.equal(posts.length, count);
            assert.equal((await inspect(lost.id)).commitment.state, 'cancellationPending');
            const recoveredCancel = await m('recurring:prepareCommand', {
                token: who,
                id: lost.id,
                kind: 'cancel'
            });
            await adapter.execute(recoveredCancel);
            assert.equal(posts.length, count + 1);
            assert.ok(posts.at(-1).path.endsWith('/' + (await inspect(lost.id)).commitment.schedule + '/cancel'));
            await adapter.observe(lost.id);
            assert.equal((await inspect(lost.id)).commitment.state, 'cancelled');
            results.push('Accepted HTTP response loss retains human cancellation through restart; exact schedule reconciles without recreation and then cancels');
            const canceled = await agreement();
            await adapter.execute(canceled.command);
            cycle(canceled, 0, { status: 'open', paymentStatus: 'processing' });
            await adapter.observe(canceled.id);
            await m('harness:control', { token: who, readonly: true });
            const cancel = await m('recurring:prepareCommand', {
                token: who,
                id: canceled.id,
                kind: 'cancel'
            });
            await adapter.execute(cancel);
            assert.deepEqual(posts.at(-1).params, { invoice_now: 'false', prorate: 'false' });
            await adapter.observe(canceled.id);
            assert.equal((await inspect(canceled.id)).commitment.state, 'cancellationPending');
            assert.equal((await inspect(canceled.id)).commitment.reservedMinor, 903);
            cycle(canceled, 0);
            await adapter.observe(canceled.id);
            assert.equal((await inspect(canceled.id)).commitment.state, 'cancelled');
            assert.equal((await inspect(canceled.id)).commitment.paidMinor, 301);
            await m('harness:control', { token: who, readonly: false });
            results.push('Readonly human cancellation uses explicit no-invoice flags; processing payment retains hold until late settlement');
            const race = await agreement();
            await assert.rejects(adapter.execute(race.command, { beforePermit: () => run('recurringFixture:epoch', { actor: f.A.actors.owner }) }), /authority changed/);
            assert.equal((await inspect(race.id)).commands[0].state, 'prepared');
            const late = await agreement();
            await adapter.execute(late.command, { afterPermit: () => run('recurringFixture:epoch', { actor: f.A.actors.owner }) });
            assert.equal((await inspect(late.id)).commands[0].late, true);
            results.push('Authority change before final consumption refuses; after consumption records one late accepted commitment');
            const dirty = await agreement();
            dirtyItems = true;
            const before = posts.length;
            await assert.rejects(adapter.execute(dirty.command));
            dirtyItems = false;
            badPrice = true;
            await assert.rejects(adapter.execute(dirty.command));
            badPrice = false;
            assert.equal(posts.length, before);
            await adapter.execute(dirty.command);
            const g1 = await m('recurring:beginObservation', { token: f.A.adapter, id: dirty.id });
            await adapter.observe(dirty.id);
            const dc = (await inspect(dirty.id)).commitment;
            await assert.rejects(m('recurring:observe', {
                token: f.A.adapter,
                id: dirty.id,
                generation: g1,
                subscription: dc.subscription,
                schedule: dc.schedule,
                terminal: true,
                cancelled: true,
                shapeValid: true,
                pendingItemsEmpty: true,
                cycles: []
            }), /stale observation/);
            for (let i = 0; i < 4; i++)
                cycle(dirty, i);
            const anomaly = await adapter.observe(dirty.id);
            assert.equal(anomaly.anomaly, 'commitment exposure exceeded');
            assert.equal((await inspect(dirty.id)).commitment.paidMinor, 1204);
            await assert.rejects(m('recurring:prepareCommand', {
                token: who,
                id: dirty.id,
                kind: 'card',
                setupIntent: dirty.p.args.setupIntent
            }), /card change refused/);
            results.push('Pending items/changed price refuse before effect; stale pull refuses; outside fourth invoice retained as anomaly, no cap fiction');
            const cardRace = await agreement();
            await adapter.execute(cardRace.command);
            await adapter.observe(cardRace.id);
            const ci = await m('recurring:prepareCommand', {
                token: who,
                id: cardRace.id,
                kind: 'card',
                setupIntent: cardRace.p.args.setupIntent
            });
            const cancel2 = await m('recurring:prepareCommand', {
                token: who,
                id: cardRace.id,
                kind: 'cancel'
            });
            const beforeCard = posts.length;
            await assert.rejects(adapter.execute(ci), /blocked/);
            assert.equal(posts.length, beforeCard);
            await adapter.execute(cancel2);
            await adapter.observe(cardRace.id);
            assert.equal((await inspect(cardRace.id)).commitment.state, 'cancelled');
            results.push('Cancellation request blocks already-prepared card update at final consume');
            const receiptHistory = await agreement();
            await adapter.execute(receiptHistory.command);
            const baseCycle = cycle(receiptHistory, 0);
            await adapter.observe(receiptHistory.id);
            const originalPI = pis.get(baseCycle.pi), extraPI = {
                ...originalPI,
                id: baseCycle.pi + '_extra',
                latest_charge: originalPI.latest_charge + '_extra'
            };
            pis.set(extraPI.id, extraPI);
            charges.set(extraPI.latest_charge, {
                ...charges.get(originalPI.latest_charge),
                id: extraPI.latest_charge,
                payment_intent: extraPI.id
            });
            payments.set('inpay_extra', {
                id: 'inpay_extra',
                invoice: baseCycle.invoice,
                livemode: false,
                currency: 'usd',
                status: 'paid',
                amount_paid: 301,
                payment: { type: 'payment_intent', payment_intent: extraPI.id }
            });
            invoices.get(baseCycle.invoice).amount_paid = 602;
            await adapter.observe(receiptHistory.id);
            payments.delete('inpay_extra');
            invoices.get(baseCycle.invoice).amount_paid = 301;
            const hs = [...schedules.values()].find(s => s.metadata.remold_commitment === receiptHistory.id);
            hs.status = 'completed';
            subs.get(hs.subscription).status = 'canceled';
            await adapter.observe(receiptHistory.id);
            const retained = await inspect(receiptHistory.id);
            assert.ok(retained.commitment.anomaly, 'Observed excess payment must not disappear after narrower pull');
            assert.ok(retained.cycles[0].payments.some(p => p.id === extraPI.id), 'Observed excess receipt identity must remain');
            assert.notEqual(retained.commitment.state, 'ended');
            results.push('Anomalous extra receipt cannot disappear or release commitment on later narrower pull');
            const snapshot = await agreement();
            await adapter.execute(snapshot.command);
            cycle(snapshot, 0);
            invoiceDrift = true;
            invoiceReads = 0;
            let driftRefused = false;
            try {
                await adapter.observe(snapshot.id);
            }
            catch {
                driftRefused = true;
            }
            invoiceDrift = false;
            const released = await agreement();
            await adapter.execute(released.command);
            const releasedSchedule = [...schedules.values()].find(s => s.metadata.remold_commitment === released.id);
            releasedSchedule.status = 'released';
            await adapter.observe(released.id);
            const releasedState = await inspect(released.id);
            assert.deepEqual({ driftRefused, releaseAnomaly: Boolean(releasedState.commitment.anomaly) }, { driftRefused: true, releaseAnomaly: true }, 'Latest invoice identity and released schedule must fail closed');
            results.push('Latest invoice currency drift refuses completion; externally released schedule retains anomaly and exposure');
            const neverDispatched = await agreement();
            const preCancelWrites = posts.length;
            assert.equal(await m('recurring:prepareCommand', {
                token: who,
                id: neverDispatched.id,
                kind: 'cancel'
            }), null);
            assert.equal((await inspect(neverDispatched.id)).commitment.reservedMinor, 0);
            await assert.rejects(adapter.execute(neverDispatched.command), /blocked|prepared/);
            const successor = await agreement({ customer: neverDispatched.p.customer._id, service: neverDispatched.p.args.service });
            assert.equal(posts.length, preCancelWrites);
            await adapter.execute(successor.command);
            assert.equal(posts.length, preCancelWrites + 1);
            results.push('Never-dispatched cancellation releases reservation and allows newly accepted same-service replacement; old activation remains refused');
            const receiptCases = [];
            function partial(row, amount) {
                const pi = pis.get(row.pi);
                pi.amount = amount;
                pi.amount_received = amount;
                charges.get(pi.latest_charge).amount = amount;
                payments.get('inpay_' + row.invoice).amount_paid = amount;
                invoices.get(row.invoice).amount_paid = amount;
            }
            function extraPayment(row, suffix, amount) {
                const original = pis.get(row.pi), pi = {
                    ...original,
                    id: row.pi + suffix,
                    amount,
                    amount_received: amount,
                    latest_charge: original.latest_charge + suffix
                };
                pis.set(pi.id, pi);
                charges.set(pi.latest_charge, {
                    ...charges.get(original.latest_charge),
                    id: pi.latest_charge,
                    payment_intent: pi.id,
                    amount
                });
                payments.set('inpay_' + row.invoice + suffix, {
                    ...payments.get('inpay_' + row.invoice),
                    id: 'inpay_' + row.invoice + suffix,
                    amount_paid: amount,
                    payment: { type: 'payment_intent', payment_intent: pi.id }
                });
            }
            for (const kind of ['disjoint-valid', 'line-changed-new-success', 'pending-then-valid', 'pending-then-invalid', 'invalid-then-reverted', 'omitted-invoice', 'duplicate-existing', 'duplicate-same-pull', 'success-regression', 'amount-regression', 'overpaid', 'incomplete-then-complete']) {
                const a = await agreement();
                await adapter.execute(a.command);
                const row = cycle(a, 0), invoice = invoices.get(row.invoice), line = invoice.lines.data[0];
                const originalStart = line.period.start;
                if (['disjoint-valid', 'line-changed-new-success', 'omitted-invoice', 'amount-regression'].includes(kind))
                    partial(row, 100);
                if (kind.startsWith('pending-then')) {
                    pis.get(row.pi).status = 'processing';
                    invoice.amount_paid = 0;
                    invoice.status = 'open';
                    payments.get('inpay_' + row.invoice).status = 'open';
                    payments.get('inpay_' + row.invoice).amount_paid = 0;
                }
                if (kind === 'invalid-then-reverted')
                    line.period.start += 3 * 86400;
                if (kind === 'incomplete-then-complete')
                    invoice.lines.has_more = true;
                if (kind !== 'duplicate-same-pull')
                    await adapter.observe(a.id);
                if (['disjoint-valid', 'line-changed-new-success'].includes(kind)) {
                    extraPayment(row, '_second', 201);
                    payments.delete('inpay_' + row.invoice);
                    invoice.amount_paid = 201;
                }
                if (kind === 'line-changed-new-success' || kind === 'pending-then-invalid')
                    line.period.start += 3 * 86400;
                if (kind.startsWith('pending-then')) {
                    pis.get(row.pi).status = 'succeeded';
                    invoice.amount_paid = 301;
                    invoice.status = 'paid';
                    payments.get('inpay_' + row.invoice).status = 'paid';
                    payments.get('inpay_' + row.invoice).amount_paid = 301;
                }
                if (kind === 'invalid-then-reverted')
                    line.period.start = originalStart;
                if (kind === 'omitted-invoice') {
                    const second = cycle(a, 1);
                    partial(second, 201);
                    invoices.delete(row.invoice);
                }
                if (kind.startsWith('duplicate-')) {
                    const second = cycle(a, 1);
                    const other = invoices.get(second.invoice);
                    other.lines.data[0].period = { ...line.period };
                    other.billing_reason = 'subscription_create';
                }
                if (kind === 'success-regression') {
                    pis.get(row.pi).status = 'requires_payment_method';
                    payments.get('inpay_' + row.invoice).status = 'open';
                    payments.get('inpay_' + row.invoice).amount_paid = 0;
                    invoice.amount_paid = 0;
                    invoice.status = 'open';
                }
                if (kind === 'amount-regression')
                    partial(row, 201);
                if (kind === 'overpaid') {
                    extraPayment(row, '_excess', 100);
                    invoice.amount_paid = 401;
                }
                if (kind === 'incomplete-then-complete')
                    invoice.lines.has_more = false;
                await adapter.observe(a.id);
                const state = (await inspect(a.id)).commitment;
                receiptCases.push({
                    kind,
                    paid: state.paidMinor,
                    held: state.reservedMinor,
                    anomaly: Boolean(state.anomaly)
                });
            }
            writeFileSync(new URL('./evidence/recognition-cases.json', import.meta.url), JSON.stringify(receiptCases, null, 2) + '\n');
            const expectedReceipts = receiptCases.map(x => ({
                kind: x.kind,
                paid: x.kind.startsWith('duplicate-') ? 602 : x.kind === 'overpaid' ? 401 : x.kind === 'amount-regression' ? 100 : 301,
                held: ['pending-then-invalid', 'invalid-then-reverted', 'duplicate-same-pull'].includes(x.kind) ? 903 : ['line-changed-new-success', 'amount-regression'].includes(x.kind) ? 803 : 602,
                anomaly: x.kind !== 'pending-then-valid'
            }));
            assert.deepEqual(receiptCases, expectedReceipts, 'Gross uses retained exact receipts; only valid immutable cycle receipts reduce reservation');
            results.push('Retained receipt union, immutable recognition and cycle ownership preserve exact gross and remaining across contradictory pulls');
            const periodCases = [];
            for (const kind of ['valid-line-different-invoice-period', 'shifted-start', 'end-outside', 'after-term', 'wrong-price', 'wrong-item', 'proration', 'extra-line', 'incomplete-lines', 'wrong-reason']) {
                const a = await agreement();
                await adapter.execute(a.command);
                const row = cycle(a, 0);
                const invoice = invoices.get(row.invoice), line = invoice.lines.data[0];
                if (kind === 'shifted-start')
                    line.period.start++;
                if (kind === 'end-outside')
                    line.period.end++;
                if (kind === 'after-term') {
                    line.period.start += 3 * 86400;
                    line.period.end += 3 * 86400;
                }
                if (kind === 'wrong-price')
                    line.pricing.price_details.price = 'price_other';
                if (kind === 'wrong-item')
                    line.parent.subscription_item_details.subscription_item = 'si_other';
                if (kind === 'proration')
                    line.parent.subscription_item_details.proration = true;
                if (kind === 'extra-line')
                    invoice.lines.data.push({ ...line, id: line.id + '_extra' });
                if (kind === 'incomplete-lines')
                    invoice.lines.has_more = true;
                if (kind === 'wrong-reason')
                    invoice.billing_reason = 'subscription_update';
                await adapter.observe(a.id);
                const state = (await inspect(a.id)).commitment;
                periodCases.push({
                    kind,
                    paid: state.paidMinor,
                    held: state.reservedMinor,
                    anomaly: Boolean(state.anomaly)
                });
            }
            writeFileSync(new URL('./evidence/line-cases.json', import.meta.url), JSON.stringify(periodCases, null, 2) + '\n');
            assert.deepEqual(periodCases, periodCases.map(x => ({
                kind: x.kind,
                paid: 301,
                held: x.kind === 'valid-line-different-invoice-period' ? 602 : 903,
                anomaly: x.kind !== 'valid-line-different-invoice-period'
            })), 'Only exact accepted recurring line may consume cycle reservation');
            results.push('Complete recurring line identity/price/cadence is required; invoice accumulation period may differ');
            assert.ok(posts.every(p => p.account === f.A.key.account));
            assert.ok(posts.every(p => !p.path.includes('/pay') && !p.path.includes('payment_intents')));
            assert.ok(posts.every(p => !Object.keys(p.params).some(k => k.includes('application_fee'))));
        }
        finally {
            await new Promise(r => server.close(r));
        }
    });
    const output = JSON.stringify({
        level: 'SERVICE actual local Convex and loopback HTTP; Stripe objects/renewal clock/identities are SIM',
        results,
        providerCalls: 0,
        modelCalls: 0
    }, null, 2) + '\n';
    for (const token of secrets)
        assert.ok(!output.includes(token));
    writeFileSync(new URL('./evidence/local.json', import.meta.url), output);
    console.log('PASS ' + results.length + ' recurring groups');
}
catch (e) {
    let text = String(e.stack ?? e);
    for (const token of secrets)
        text = text.replaceAll(token, '[private]');
    console.error(text);
    process.exitCode = 1;
}
