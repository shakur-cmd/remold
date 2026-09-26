import { cadence } from './cadence';
import { mutation, query, action, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id, Doc } from './_generated/dataModel';
import { v } from 'convex/values';
type Ctx = MutationCtx | QueryCtx;
function fail(s: string): never {
    throw Error(s);
}
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(n => n.toString(16).padStart(2, '0')).join('');
async function principal(ctx: Ctx, token: string) {
    const session = await ctx.db.query('sessions').withIndex('token', q => q.eq('token', token)).unique(), actor = session?.actor 
        && await ctx.db.get(session.actor);
    if (!session || !actor || actor.state !== 'active')
        fail('actor inactive');
    return { session, actor };
}
async function finance(ctx: Ctx, token: string) {
    const p = await principal(ctx, token), member = await ctx.db.query('financeMembers').withIndex('actor', q => q.eq('actor', p.actor._id)).unique();
    if (p.actor.kind !== 'human' || !member || !['admin', 'finance'].includes(member.role))
        fail('human finance authority required');
    return p;
}
async function owned<T extends {
    org: Id<'orgs'>;
}>(ctx: Ctx, token: string, row: T | null) {
    const p = await principal(ctx, token);
    if (!row || row.org !== p.actor.org)
        fail('tenant denied');
    return row;
}
async function writable(ctx: Ctx, org: Id<'orgs'>, binding: Id<'bindings'>) {
    const o = await ctx.db.get(org), b = await ctx.db.get(binding);
    if (o?.readonly)
        fail('readonly');
    if (!b || b.org !== org || !b.healthy)
        fail('merchant unavailable');
}
async function scoped(ctx: Ctx, token: string, id: Id<'recurringCommitments'>) {
    const c = await ctx.db.get(id);
    if (!c)
        fail('commitment missing');
    const b = await ctx.db.get(c.binding), s = await ctx.db.query('sessions').withIndex('token', q => q.eq('token', token)).unique();
    if (!b 
        || !s?.adapterScope 
        || s.adapterScope.provider !== b.provider 
        || s.adapterScope.environment !== b.environment 
        || s.adapterScope.account !== b.account)
        fail('adapter account denied');
    return { c, b };
}
async function audit(ctx: MutationCtx, c: {
    org: Id<'orgs'>;
}, actor: string, kind: string, resource: string) {
    await ctx.db.insert('events', {
        org: c.org,
        actor,
        kind,
        resource,
        at: Date.now()
    });
}
const planArgs = {
    token: v.string(),
    customer: v.id('payCustomers'),
    service: v.string(),
    price: v.string(),
    setupIntent: v.string(),
    testClock: v.optional(v.string()),
    interval: v.union(v.literal('day'), v.literal('month')),
    start: v.number(),
    amountMinor: v.literal(301),
    cycles: v.literal(3),
    currency: v.literal('usd')
};
export const propose = mutation({ args: planArgs, handler: async (ctx, a) => {
        const p = await principal(ctx, a.token), customer = await owned(ctx, a.token, await ctx.db.get(a.customer));
        await writable(ctx, customer.org, customer.binding);
        if (customer.deleted 
            || !a.service 
            || a.service.length > 100 
            || !a.price.startsWith('price_') 
            || !a.setupIntent.startsWith('seti_')
            || (a.testClock !== undefined && !/^clock_[A-Za-z0-9]+$/.test(a.testClock))
            || !Number.isSafeInteger(a.start) 
            || a.start <= 0)
            fail('invalid recurring terms');
        cadence(a, 3);
        const old = await ctx.db.query('recurringPlans').withIndex('version', q => q.eq('customer', a.customer).eq('service', a.service)).order('desc').first();
        const { token, ...terms } = a, version = (old?.version ?? 0) + 1, snapshot = {
            ...terms,
            version,
            binding: customer.binding
        };
        const id = await ctx.db.insert('recurringPlans', {
            ...terms,
            org: customer.org,
            binding: customer.binding,
            author: p.actor._id,
            version,
            hash: await sha(JSON.stringify(snapshot))
        });
        await audit(ctx, customer, p.actor._id, 'recurring.proposed', id);
        return id;
    } });
export const issueAcceptance = action({ args: { token: v.string(), plan: v.id('recurringPlans') }, handler: async (ctx, a): Promise<{
        token: string;
        hash: string;
    }> => {
        const token = crypto.randomUUID() + crypto.randomUUID(), hash = await ctx.runMutation(internal.recurring.acceptance, { ...a, tokenHash: await sha(token) });
        return { token, hash };
    } });
export const acceptance = internalMutation({ args: {
        token: v.string(),
        plan: v.id('recurringPlans'),
        tokenHash: v.string()
    }, handler: async (ctx, a) => {
        await finance(ctx, a.token);
        const p = await owned(ctx, a.token, await ctx.db.get(a.plan));
        await writable(ctx, p.org, p.binding);
        if (p.acceptedAt)
            fail('accepted terms immutable');
        await ctx.db.patch(p._id, { tokenHash: a.tokenHash, expires: Date.now() + 60000 });
        return p.hash;
    } });
export const accept = mutation({ args: {
        plan: v.id('recurringPlans'),
        token: v.string(),
        hash: v.string()
    }, handler: async (ctx, a) => {
        const p = await ctx.db.get(a.plan);
        if (!p || p.hash !== a.hash || p.tokenHash !== await sha(a.token) || !p.expires || p.expires < Date.now())
            fail('invalid acceptance');
        if (p.acceptedAt)
            return p._id;
        await writable(ctx, p.org, p.binding);
        await ctx.db.patch(p._id, { acceptedAt: Date.now() });
        await audit(ctx, p, 'customer-acceptance', 'recurring.accepted', p._id);
        return p._id;
    } });
export const adopt = mutation({ args: { token: v.string(), plan: v.id('recurringPlans') }, handler: async (ctx, a) => {
        const who = await finance(ctx, a.token), p = await owned(ctx, a.token, await ctx.db.get(a.plan));
        await writable(ctx, p.org, p.binding);
        if (!p.acceptedAt)
            fail('accepted service required');
        const old = await ctx.db.query('recurringCommitments').withIndex('service', q => q.eq('customer', p.customer).eq('service', p.service)).order('desc').first();
        if (old) {
            if (old.plan === p._id)
                fail('already adopted');
            if (!['ended', 'cancelled'].includes(old.state) || !old.complete || old.reservedMinor !== 0 || old.anomaly)
                fail('prior commitment unresolved');
            const previous = await ctx.db.get(old.plan);
            const oldCommands = await ctx.db.query('recurringCommands').withIndex('commitment', q => q.eq('commitment', old._id)).take(30);
            const neverDispatched = old.state === 'cancelled' 
                && !old.schedule 
                && !old.subscription 
                && oldCommands.length === 1 
                && oldCommands[0].kind === 'activate' 
                && oldCommands[0].state === 'prepared';
            if (!previous || p.version <= previous.version || (!neverDispatched && p.start < (old.providerEnd ?? Infinity)))
                fail('replacement overlap');
        }
        const id = await ctx.db.insert('recurringCommitments', {
            org: p.org,
            binding: p.binding,
            customer: p.customer,
            plan: p._id,
            service: p.service,
            actor: who.actor._id,
            actorEpoch: who.actor.epoch,
            session: who.session._id,
            author: p.author,
            generation: (old?.generation ?? 0) + 1,
            state: 'prepared',
            capMinor: 903,
            reservedMinor: 903,
            paidMinor: 0,
            recognizedMinor: 0,
            observation: 0,
            complete: false,
            cancelRequested: false
        });
        const command = await ctx.db.insert('recurringCommands', {
            org: p.org,
            commitment: id,
            kind: 'activate',
            actor: who.actor._id,
            actorEpoch: who.actor.epoch,
            session: who.session._id,
            expires: Date.now() + 60000,
            state: 'prepared',
            late: false
        });
        await audit(ctx, p, who.actor._id, 'recurring.humanAdopted', id);
        return { id, command };
    } });
export const prepareCommand = mutation({ args: {
        token: v.string(),
        id: v.id('recurringCommitments'),
        kind: v.union(v.literal('card'), v.literal('cancel')),
        setupIntent: v.optional(v.string())
    }, handler: async (ctx, a) => {
        const who = await finance(ctx, a.token), c = await owned(ctx, a.token, await ctx.db.get(a.id));
        if (a.kind === 'card') {
            await writable(ctx, c.org, c.binding);
            if (c.state !== 'active' || c.cancelRequested || c.anomaly || !c.complete || c.paidMinor >= 903 || !a.setupIntent?.startsWith('seti_'))
                fail('card change refused');
        }
        else {
            if (a.setupIntent)
                fail('cancel payload');
            if (['ended', 'cancelled'].includes(c.state))
                fail('already terminal');
            await ctx.db.patch(c._id, { cancelRequested: true, state: 'cancelRequested' });
        }
        const commands = await ctx.db.query('recurringCommands').withIndex('commitment', q => q.eq('commitment', c._id)).take(30);
        if (commands.length === 30)
            fail('command limit');
        if (commands.some(x => x.kind === a.kind && x.state !== 'confirmed'))
            fail('prior command unresolved');
        if (a.kind === 'cancel' && !c.schedule) {
            const activation = commands.find(x => x.kind === 'activate');
            if (activation?.state === 'prepared') {
                await ctx.db.patch(c._id, {
                    state: 'cancelled',
                    reservedMinor: 0,
                    complete: true
                });
                await audit(ctx, c, who.actor._id, 'recurring.cancelledBeforeActivation', c._id);
                return null;
            }
            await ctx.db.patch(c._id, { state: 'cancellationPending', complete: false });
            await audit(ctx, c, who.actor._id, 'recurring.cancelRequestedWhileUnknown', c._id);
            return null;
        }
        const id = await ctx.db.insert('recurringCommands', {
            org: c.org,
            commitment: c._id,
            kind: a.kind,
            actor: who.actor._id,
            actorEpoch: who.actor.epoch,
            session: who.session._id,
            ...(a.setupIntent ? { setupIntent: a.setupIntent } : {}),
            expires: Date.now() + 60000,
            state: 'prepared',
            late: false
        });
        await audit(ctx, c, who.actor._id, 'recurring.' + a.kind + 'Prepared', id);
        return id;
    } });
export const context = query({ args: { token: v.string(), id: v.id('recurringCommitments') }, handler: async (ctx, a) => {
        const { c, b } = await scoped(ctx, a.token, a.id), plan = await ctx.db.get(c.plan), customer = await ctx.db.get(c.customer);
        if (!plan || !customer || customer.binding !== b._id || customer.deleted)
            fail('binding lost');
        const cycles = await ctx.db.query('recurringCycles').withIndex('commitment', q => q.eq('commitment', c._id)).take(11);
        if (cycles.length > 10) fail('cycle history bound');
        const history = await ctx.db.query('recurringCommitments').withIndex('service', q => q.eq('customer', c.customer)).take(101);
        if (history.length > 100) fail('commitment history bound');
        return {
            commitment: c,
            cycles,
            providerHistory: history.map(row => ({ schedule: row.schedule, subscription: row.subscription })),
            plan,
            customer,
            account: b.account,
            environment: b.environment
        };
    } });
export const command = query({ args: { token: v.string(), id: v.id('recurringCommands') }, handler: async (ctx, a) => {
        const command = await ctx.db.get(a.id);
        if (!command)
            fail('command missing');
        await scoped(ctx, a.token, command.commitment);
        return command;
    } });
export const consume = mutation({ args: { token: v.string(), id: v.id('recurringCommands') }, handler: async (ctx, a) => {
        const cmd = await ctx.db.get(a.id);
        if (!cmd)
            fail('command missing');
        const { c, b } = await scoped(ctx, a.token, cmd.commitment);
        if (cmd.state !== 'prepared' || cmd.expires <= Date.now())
            fail('permit consumed or expired');
        const session = await ctx.db.get(cmd.session);
        if (!session?.actor || session.actor !== cmd.actor)
            fail('session revoked');
        const who = await finance(ctx, session.token);
        if (who.actor._id !== cmd.actor || who.actor.epoch !== cmd.actorEpoch)
            fail('authority changed');
        if (cmd.kind !== 'cancel') {
            await writable(ctx, c.org, c.binding);
            if (c.cancelRequested || c.anomaly)
                fail('commitment blocked');
            if (cmd.kind === 'activate' && (c.state !== 'prepared' || c.reservedMinor !== 903))
                fail('activation not prepared');
            if (cmd.kind === 'card' && (c.state !== 'active' || !c.complete || c.paidMinor >= 903))
                fail('card change refused');
        }
        else if (!c.cancelRequested || !c.schedule)
            fail('cancellation not prepared');
        await ctx.db.patch(cmd._id, { state: 'consumed' });
        if (cmd.kind === 'activate')
            await ctx.db.patch(c._id, { state: 'activating' });
        await audit(ctx, c, cmd.actor, 'recurring.' + cmd.kind + 'Consumed', cmd._id);
        return {
            command: cmd._id,
            commitment: c._id,
            kind: cmd.kind,
            account: b.account,
            key: 'recurring:' + cmd._id,
            plan: c.plan,
            ...(cmd.setupIntent ? { setupIntent: cmd.setupIntent } : {})
        };
    } });
export const unknown = mutation({ args: { token: v.string(), id: v.id('recurringCommands') }, handler: async (ctx, a) => {
        const cmd = await ctx.db.get(a.id);
        if (!cmd)
            fail('command missing');
        const { c } = await scoped(ctx, a.token, cmd.commitment);
        if (!['consumed', 'unknown'].includes(cmd.state))
            fail('not dispatched');
        await ctx.db.patch(cmd._id, { state: 'unknown' });
        await ctx.db.patch(c._id, { complete: false, ...(cmd.kind === 'activate' ? { state: c.cancelRequested ? 'cancellationPending' as const : 'outcomeUnknown' as const } : cmd.kind === 'cancel' ? { state: 'cancellationPending' as const } : {}) });
    } });
export const settled = mutation({ args: {
        token: v.string(),
        id: v.id('recurringCommands'),
        providerRef: v.string(),
        subscription: v.optional(v.string()),
        subscriptionItem: v.optional(v.string()),
        providerEnd: v.optional(v.number())
    }, handler: async (ctx, a) => {
        const cmd = await ctx.db.get(a.id);
        if (!cmd)
            fail('command missing');
        const { c } = await scoped(ctx, a.token, cmd.commitment);
        if (cmd.state === 'confirmed') {
            if (cmd.providerRef !== a.providerRef)
                fail('receipt mismatch');
            return;
        }
        if (!['consumed', 'unknown'].includes(cmd.state))
            fail('unconsumed receipt');
        if (cmd.kind === 'activate') {
            if (!a.providerRef.startsWith('sub_sched_') 
                || !a.subscription?.startsWith('sub_') 
                || !a.subscriptionItem?.startsWith('si_') 
                || !Number.isSafeInteger(a.providerEnd) 
                || a.providerEnd! <= 0)
                fail('invalid schedule receipt');
            const collision = await ctx.db.query('recurringCommitments').withIndex('schedule', q => q.eq('binding', c.binding).eq('schedule', a.providerRef)).unique();
            if (collision && collision._id !== c._id)
                fail('schedule already bound');
            await ctx.db.patch(c._id, {
                schedule: a.providerRef,
                subscription: a.subscription,
                subscriptionItem: a.subscriptionItem,
                providerEnd: a.providerEnd,
                state: c.cancelRequested ? 'cancellationPending' : 'active'
            });
        }
        else if (a.providerRef !== (cmd.kind === 'cancel' ? c.schedule : c.subscription))
            fail('receipt target mismatch');
        if (cmd.kind === 'cancel')
            await ctx.db.patch(c._id, { state: 'cancellationPending', complete: false });
        const actor = await ctx.db.get(cmd.actor);
        await ctx.db.patch(cmd._id, {
            state: 'confirmed',
            providerRef: a.providerRef,
            late: !actor 
                || actor.state !== 'active' 
                || actor.epoch !== cmd.actorEpoch 
                || (cmd.kind !== 'cancel' 
                && Boolean((await ctx.db.get(c.org))?.readonly))
        });
        await audit(ctx, c, 'trusted-recurring-adapter', 'recurring.' + cmd.kind + 'Accepted', cmd._id);
    } });
export const beginObservation = mutation({ args: { token: v.string(), id: v.id('recurringCommitments') }, handler: async (ctx, a) => {
        const { c } = await scoped(ctx, a.token, a.id);
        if (!c.subscription)
            fail('provider identity unknown');
        const generation = c.observation + 1;
        await ctx.db.patch(c._id, { observation: generation, complete: false });
        return generation;
    } });
const payment = v.object({
    id: v.string(),
    invoicePayment: v.optional(v.string()),
    amountMinor: v.number(),
    status: v.union(v.literal('pending'), v.literal('succeeded'), v.literal('failed'), v.literal('cancelled'))
});
const line = v.union(v.null(), v.object({
    id: v.string(),
    subscriptionItem: v.string(),
    price: v.string(),
    serviceStart: v.number(),
    serviceEnd: v.number()
}));
const cycle = v.object({
    invoice: v.string(),
    subscription: v.string(),
    period: v.number(),
    amountMinor: v.number(),
    paidMinor: v.number(),
    status: v.string(),
    autoAdvance: v.boolean(),
    payments: v.array(payment),
    lineComplete: v.boolean(),
    lineShape: v.boolean(),
    line,
    billingReason: v.string()
});
function sum(values: number[]): number {
    const total = values.reduce((n, value) => n + value, 0);
    if (!Number.isSafeInteger(total) || total < 0 || total > 100000000000)
        fail('Receipt sum bound');
    return total;
}
function sameLine(a: Doc<'recurringCycles'>['line'], b: Doc<'recurringCycles'>['line']): boolean {
    return Boolean(a 
        && b 
        && a.id === b.id 
        && a.subscriptionItem === b.subscriptionItem 
        && a.price === b.price 
        && a.serviceStart === b.serviceStart 
        && a.serviceEnd === b.serviceEnd);
}
export const observe = mutation({ args: {
        token: v.string(),
        id: v.id('recurringCommitments'),
        generation: v.number(),
        subscription: v.string(),
        schedule: v.string(),
        terminal: v.boolean(),
        cancelled: v.boolean(),
        shapeValid: v.boolean(),
        pendingItemsEmpty: v.boolean(),
        cycles: v.array(cycle)
    }, handler: async (ctx, a) => {
        const { c } = await scoped(ctx, a.token, a.id);
        if (c.observation !== a.generation)
            fail('stale observation');
        if (c.subscription !== a.subscription || c.schedule !== a.schedule)
            fail('provider lineage mismatch');
        if (a.cycles.length > 10)
            fail('observation bound');
        const plan = await ctx.db.get(c.plan);
        if (!plan)
            fail('plan missing');
        const known = await ctx.db.query('recurringCycles').withIndex('binding', q => q.eq('binding', c.binding)).take(101);
        if (known.length > 100)
            fail('cycle history bound');
        const old = known.filter(row => row.commitment === c._id);
        const byInvoice = new Map(known.map(row => [row.invoice, row]));
        const paymentOwners = new Map(known.flatMap(row => row.payments.map(p => [p.id, row.invoice] as const)));
        const claims = new Map(old.filter(row => row.lineDecision === 'valid' 
            && row.cycleIndex !== undefined).map(row => [row.cycleIndex!, row.invoice]));
        const indices = a.cycles.map(item => {
            if (!item.lineComplete 
                || !item.lineShape 
                || !item.line 
                || item.line.price !== plan.price 
                || item.line.subscriptionItem !== c.subscriptionItem)
                return undefined;
            for (let index = 0; index < 3; index++) {
                if (item.line.serviceStart === cadence(plan, index) 
                    && item.line.serviceEnd === cadence(plan, index + 1) 
                    && item.billingReason === (index === 0 ? 'subscription_create' : 'subscription_cycle'))
                    return index;
            }
            return undefined;
        });
        const claimants = new Map<number, string[]>();
        a.cycles.forEach((item, position) => {
            const existing = byInvoice.get(item.invoice), index = indices[position];
            if (index !== undefined && (!existing || existing.lineDecision === 'unidentified'))
                claimants.set(index, [...(claimants.get(index) ?? []), item.invoice]);
        });
        if (known.length + a.cycles.filter(item => !byInvoice.has(item.invoice)).length > 100)
            fail('cycle history bound');
        const ids = new Set<string>(), incomingPayments = new Set<string>();
        let anomaly = c.anomaly ?? (!a.shapeValid || !a.pendingItemsEmpty ? 'provider shape changed' : undefined);
        for (let position = 0; position < a.cycles.length; position++) {
            const item = a.cycles[position], existing = byInvoice.get(item.invoice), proposedIndex = indices[position];
            if (item.subscription !== c.subscription 
                || !Number.isSafeInteger(item.period) 
                || item.payments.length > 10 
                || ![item.amountMinor, item.paidMinor, ...item.payments.map(p => p.amountMinor)].every(n => Number.isSafeInteger(n) 
                && n >= 0 
                && n <= 100000000))
                fail('invalid cycle facts');
            if (ids.has(item.invoice))
                fail('duplicate invoice');
            ids.add(item.invoice);
            if (existing && (existing.commitment !== c._id || existing.subscription !== item.subscription))
                fail('invoice already bound');
            let rowAnomaly = existing?.anomaly;
            let decision: Doc<'recurringCycles'>['lineDecision'] = existing?.lineDecision ?? 'unidentified';
            let canonical = existing?.line ?? null, index = existing?.cycleIndex;
            if (decision === 'unidentified' && item.lineComplete) {
                const available = proposedIndex !== undefined 
                    && (!claims.has(proposedIndex) 
                    || claims.get(proposedIndex) === item.invoice) 
                    && (claimants.get(proposedIndex)?.length ?? 0) === 1;
                decision = available ? 'valid' : 'invalid';
                canonical = item.line;
                if (available) {
                    index = proposedIndex;
                    claims.set(index!, item.invoice);
                }
            }
            const matches = decision === 'valid' && item.lineComplete && proposedIndex === index && sameLine(canonical, item.line);
            if (!item.lineComplete)
                rowAnomaly ??= 'incomplete recurring line';
            else if (!matches)
                rowAnomaly ??= 'recurring line outside accepted cycle';
            const retained = new Map<string, Doc<'recurringCycles'>['payments'][number]>(existing?.payments.map(p => [p.id, p]) ?? []);
            for (const next of item.payments) {
                if (incomingPayments.has(next.id) || (paymentOwners.has(next.id) && paymentOwners.get(next.id) !== item.invoice))
                    fail('payment already used');
                incomingPayments.add(next.id);
                const prior = retained.get(next.id);
                if (prior?.invoicePayment && prior.invoicePayment !== next.invoicePayment)
                    fail('invoice payment identity changed');
                if (prior && prior.amountMinor !== next.amountMinor) {
                    rowAnomaly ??= 'receipt amount changed';
                    continue;
                }
                if (prior?.status === 'succeeded' && next.status !== 'succeeded') {
                    rowAnomaly ??= 'receipt regression';
                    continue;
                }
                let eligible = prior?.eligible;
                if (eligible === undefined && next.status === 'succeeded' && item.lineComplete)
                    eligible = matches;
                retained.set(next.id, { ...next, ...(eligible === undefined ? {} : { eligible }) });
            }
            if (retained.size > 10)
                fail('receipt history bound');
            if (existing?.payments.some(prior => !item.payments.some(next => next.id === prior.id)))
                rowAnomaly ??= 'receipt regression';
            const payments = [...retained.values()];
            const gross = sum(payments.filter(p => p.status === 'succeeded').map(p => p.amountMinor));
            const seen = sum(item.payments.filter(p => p.status === 'succeeded').map(p => p.amountMinor));
            if (item.amountMinor !== 301 || item.paidMinor !== seen || gross > 301)
                rowAnomaly ??= 'unexplained cycle amount';
            if (payments.some(p => p.status === 'succeeded' && p.eligible === false))
                rowAnomaly ??= 'ineligible payment';
            const row = {
                commitment: c._id,
                binding: c.binding,
                invoice: item.invoice,
                subscription: item.subscription,
                period: item.period,
                amountMinor: item.amountMinor,
                paidMinor: gross,
                observedPaidMinor: item.paidMinor,
                status: item.status,
                autoAdvance: item.autoAdvance,
                payments,
                line: canonical,
                observedLine: item.line,
                lineDecision: decision,
                cycleIndex: index,
                anomaly: rowAnomaly
            };
            if (existing)
                await ctx.db.patch(existing._id, row);
            else
                await ctx.db.insert('recurringCycles', row);
            anomaly ??= rowAnomaly;
            await audit(ctx, c, 'trusted-recurring-adapter', 'recurring.invoiceObserved', item.invoice);
        }
        if (old.some(row => !ids.has(row.invoice)))
            anomaly ??= 'incomplete invoice history';
        const retained = await ctx.db.query('recurringCycles').withIndex('commitment', q => q.eq('commitment', c._id)).take(101);
        if (retained.length > 100)
            fail('cycle history bound');
        const gross = sum(retained.flatMap(row => row.payments.filter(p => p.status === 'succeeded').map(p => p.amountMinor)));
        const recognized = sum(retained.filter(row => row.lineDecision === 'valid').map(row => Math.min(301, sum(row.payments.filter(p => p.status === 'succeeded' 
            && p.eligible === true).map(p => p.amountMinor)))));
        if (gross > 903 || recognized > 903)
            anomaly = 'commitment exposure exceeded';
        if (recognized > 903)
            fail('recognized amount bound');
        const commands = await ctx.db.query('recurringCommands').withIndex('commitment', q => q.eq('commitment', c._id)).take(30);
        const pending = commands.some(cmd => ['consumed', 'unknown'].includes(cmd.state)) 
            || retained.some(row => row.payments.some(p => p.status === 'pending') 
            || !['paid', 'void'].includes(row.status) 
            || (a.terminal 
            && row.autoAdvance));
        const terminal = a.terminal && !pending && !anomaly;
        await ctx.db.patch(c._id, {
            paidMinor: gross,
            recognizedMinor: recognized,
            reservedMinor: terminal ? 0 : 903 - recognized,
            complete: !anomaly,
            anomaly,
            ...(terminal ? { state: a.cancelled ? 'cancelled' as const : 'ended' as const } : c.cancelRequested ? { state: 'cancellationPending' as const } : {})
        });
        return {
            anomaly: anomaly ?? null,
            terminal,
            paidMinor: gross,
            recognizedMinor: recognized
        };
    } });
export const inspect = query({ args: { token: v.string(), id: v.id('recurringCommitments') }, handler: async (ctx, a) => {
        await finance(ctx, a.token);
        const commitment = await owned(ctx, a.token, await ctx.db.get(a.id));
        return {
            commitment,
            commands: await ctx.db.query('recurringCommands').withIndex('commitment', q => q.eq('commitment', a.id)).take(30),
            cycles: await ctx.db.query('recurringCycles').withIndex('commitment', q => q.eq('commitment', a.id)).take(11)
        };
    } });
