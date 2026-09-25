import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { withRecurring } from '../../../../proofs/payments/recurring/local.mjs';
import { recurringAdapter, termEnd } from '../../../../proofs/payments/recurring/adapter.mjs';
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
            const summarize=async(a,name)=>{const s=await inspect(a.id);const result={name,paid:s.commitment.paidMinor,recognized:s.commitment.recognizedMinor,held:s.commitment.reservedMinor,state:s.commitment.state,anomaly:s.commitment.anomaly??null,invoices:s.cycles.length,receiptSum:s.cycles.flatMap(c=>c.payments).filter(p=>p.status==='succeeded').reduce((n,p)=>n+p.amountMinor,0)};results.push(result);return result;};
            const partial=(row,n)=>{const pi=pis.get(row.pi);pi.amount=pi.amount_received=n;charges.get(pi.latest_charge).amount=n;const pay=[...payments.values()].find(p=>p.invoice===row.invoice);pay.amount_paid=n;invoices.get(row.invoice).amount_paid=n;};
            const another=(row,n)=>{const old=pis.get(row.pi),pid=old.id+'_iv_'+n,ch=old.latest_charge+'_iv_'+n,ip=[...payments.values()].find(p=>p.invoice===row.invoice);pis.set(pid,{...old,id:pid,amount:n,amount_received:n,latest_charge:ch});charges.set(ch,{...charges.get(old.latest_charge),id:ch,payment_intent:pid,amount:n});payments.set(ip.id+'_iv',{...ip,id:ip.id+'_iv',amount_paid:n,payment:{type:'payment_intent',payment_intent:pid}});payments.delete(ip.id);invoices.get(row.invoice).amount_paid=n;};
            for(const kind of ['valid-different-accumulation','shift17','at-term-end','wrong-line-price']){
                const a=await agreement({service:'iv-line-'+kind});await adapter.execute(a.command);const row=cycle(a,0),invoice=invoices.get(row.invoice),line=invoice.lines.data[0];invoice.period_start=a.p.args.start-123456;invoice.period_end=a.p.args.start-888;
                if(kind==='shift17'){line.period.start+=17;line.period.end+=17;}if(kind==='at-term-end'){line.period.start+=259200;line.period.end+=259200;}if(kind==='wrong-line-price')line.pricing.price_details.price='price_iv_wrong';
                const schedule=[...schedules.values()].find(s=>s.metadata.remold_commitment===a.id);schedule.status='completed';subs.get(schedule.subscription).status='canceled';await adapter.observe(a.id);const s=await summarize(a,kind);assert.equal(s.paid,301);if(kind.startsWith('valid')){assert.equal(s.anomaly,null);assert.equal(s.state,'ended');assert.equal(s.held,0);}else{assert.ok(s.anomaly);assert.notEqual(s.state,'ended');assert.equal(s.recognized,0);assert.equal(s.held,903);}
            }
            for(const kind of ['disjoint-valid','disjoint-invalid-new','omitted-invoice']){
                const a=await agreement({service:'iv-'+kind});await adapter.execute(a.command);const row=cycle(a,0);partial(row,100);await adapter.observe(a.id);assert.equal((await inspect(a.id)).commitment.reservedMinor,803);
                if(kind==='omitted-invoice'){const next=cycle(a,1);partial(next,201);invoices.delete(row.invoice);}else{another(row,201);if(kind==='disjoint-invalid-new')invoices.get(row.invoice).lines.data[0].period.end+=17;}
                await adapter.observe(a.id);const s=await summarize(a,kind);assert.equal(s.paid,301);assert.equal(s.receiptSum,301);assert.ok(s.anomaly);assert.equal(s.recognized,kind==='disjoint-invalid-new'?100:301);assert.equal(s.held,kind==='disjoint-invalid-new'?803:602);
                if(kind==='omitted-invoice'){assert.equal(s.invoices,2);await restart();await adapter.observe(a.id);const r=await summarize(a,'omitted-after-restart');assert.equal(r.paid,301);assert.equal(r.held,602);assert.equal(r.invoices,2);}
            }
            const lost=await agreement({service:'iv-double-loss'});lose=true;await assert.rejects(adapter.execute(lost.command));const before=posts.length;assert.equal(await m('recurring:prepareCommand',{token:who,id:lost.id,kind:'cancel'}),null);assert.equal(await m('recurring:prepareCommand',{token:who,id:lost.id,kind:'cancel'}),null);await restart();await adapter.reconcileActivation(lost.command);assert.equal(posts.length,before);assert.equal((await inspect(lost.id)).commitment.state,'cancellationPending');
            cycle(lost,0,{status:'open',paymentStatus:'processing'});await adapter.observe(lost.id);const cancel=await m('recurring:prepareCommand',{token:who,id:lost.id,kind:'cancel'});lose=true;await assert.rejects(adapter.execute(cancel));await restart();await adapter.reconcileCommand(cancel);await adapter.observe(lost.id);const pending=await summarize(lost,'cancel-response-loss-processing');assert.equal(pending.held,903);assert.equal(pending.state,'cancellationPending');cycle(lost,0);await adapter.observe(lost.id);const late=await summarize(lost,'cancel-response-loss-late-success');assert.equal(late.paid,301);assert.equal(late.held,0);assert.equal(late.state,'cancelled');assert.equal(posts.length,before+1);
            const never=await agreement({service:'iv-never'});const count=posts.length;await m('recurring:prepareCommand',{token:who,id:never.id,kind:'cancel'});await assert.rejects(adapter.execute(never.command),/blocked|prepared/);const replacement=await agreement({customer:never.p.customer._id,service:never.p.args.service});await adapter.execute(replacement.command);assert.equal(posts.length,count+1);results.push({name:'prepared-cancel-replacement',oldHeld:(await inspect(never.id)).commitment.reservedMinor,newHeld:(await inspect(replacement.id)).commitment.reservedMinor,newActivationPosts:1});
        }finally{await new Promise(r=>server.close(r));}
    });
    writeFileSync(new URL('./altered-result.json',import.meta.url),JSON.stringify({sourceAggregate:'28735f6b846e88b0fecaeee2866a568cf5662cc3baacfa5b2d5aed728bf4a57d',level:'SERVICE local Convex and loopback; SIM provider/clock/identities',results,externalProviderCalls:0},null,2)+'\n');console.log('PASS '+results.length+' independent observations');
}catch(e){let text=String(e.stack??e);for(const token of secrets)text=text.replaceAll(token,'[private]');console.error(text);process.exitCode=1;}
