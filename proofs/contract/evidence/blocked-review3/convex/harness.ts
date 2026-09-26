import { mutation, query, internalMutation, internalQuery } from './_generated/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { capability, payload, scope, within, project, type Scope } from './contract';
type Ctx = MutationCtx | QueryCtx;
function deny(why: string): never { throw new Error(why); }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
async function session(ctx: Ctx, token: string) { return await ctx.db.query('sessions').withIndex('token', q => q.eq('token', token)).unique() ?? deny('invalid session'); }
async function actor(ctx: Ctx, token: string) {
    const s = await session(ctx, token), a = s.actor && await ctx.db.get(s.actor);
    if (!a || a.state !== 'active')
        deny('actor inactive');
    return a;
}
async function own<T extends {
    org: Id<'orgs'>;
}>(a: Doc<'actors'>, r: T | null) {
    if (!r || r.org !== a.org)
        deny('tenant denied');
    return r;
}
async function adapter(ctx: Ctx, token: string, binding: Doc<'bindings'>) {
    const s = await session(ctx, token), scope = s.adapterScope;
    if (!scope)
        deny('adapter only');
    if (scope.provider !== binding.provider || scope.environment !== binding.environment || scope.account !== binding.account)
        deny('adapter scope denied');
}
async function adapterOp(ctx: Ctx, token: string, id: Id<'operations'>) {
    const op = await ctx.db.get(id);
    if (!op)
        deny('unknown operation');
    const binding = await ctx.db.get(op.binding);
    if (!binding)
        deny('binding unknown');
    await adapter(ctx, token, binding);
    return op;
}
async function audit(ctx: MutationCtx, org: Id<'orgs'>, actor: string, kind: string, resource: string) { await ctx.db.insert('events', { org, actor, kind, resource, at: Date.now() }); }
async function writable(ctx: Ctx, id: Id<'orgs'>) {
    const org = await ctx.db.get(id);
    if (!org || org.readonly)
        deny('readonly');
    return org;
}
async function liveGrant(ctx: Ctx, id: Id<'grants'>, seen: Id<'grants'>[] = []): Promise<Doc<'grants'>> {
    if (seen.includes(id) || seen.length >= 8)
        deny('grant chain depth/cycle');
    const g = await ctx.db.get(id);
    if (!g || g.revokedAt !== undefined || g.expires <= Date.now())
        deny('grant revoked/expired');
    const giver = await ctx.db.get(g.grantor), recipient = await ctx.db.get(g.actor);
    if (!giver || !recipient || giver.org !== g.org || recipient.org !== g.org || giver.state !== 'active' || recipient.state !== 'active' || giver.epoch !== g.grantorEpoch)
        deny('grant ancestry revoked');
    if (g.parent) {
        const p = await liveGrant(ctx, g.parent, [...seen, id]);
        if (p.actor !== g.grantor || !p.delegate || p.capability !== g.capability || g.expires > p.expires || (g.mode === 'direct' && p.mode !== 'direct') || !within(g.scope, p.scope))
            deny('delegation escalation');
    }
    else if (giver.kind !== 'human')
        deny('human root required');
    return g;
}
async function validGrants(ctx: Ctx, a: Doc<'actors'>, cap: Doc<'grants'>['capability']) {
    const result: Doc<'grants'>[] = [];
    for (const g of await ctx.db.query('grants').filter(q => q.and(q.eq(q.field('actor'), a._id), q.eq(q.field('capability'), cap))).collect()) {
        try {
            result.push(await liveGrant(ctx, g._id));
        }
        catch { }
    }
    return result;
}
async function manage(ctx: Ctx, a: Doc<'actors'>, target: Id<'actors'>) {
    if (a.kind === 'human')
        return;
    for (const initial of await ctx.db.query('grants').filter(q => q.eq(q.field('actor'), a._id)).collect()) {
        let g: Doc<'grants'> | null = initial, depth = 0;
        while (g) {
            if (g.grantor === target)
                deny('ancestor manage denied');
            if (++depth > 8)
                deny('grant chain depth');
            g = g.parent ? await ctx.db.get(g.parent) : null;
        }
    }
    const gs = await validGrants(ctx, a, 'agent.manage');
    if (!gs.some(g => g.scope.kind === 'agents' && g.scope.agents.includes(target)))
        deny('outside manage scope');
}
function matches(g: Doc<'grants'>, op: Doc<'operations'>) {
    const s = g.scope;
    if (s.kind === 'bindings')
        return s.bindings.includes(op.binding) && s.currency === op.payload.currency && s.maxAmountMinor >= op.payload.amountMinor && s.maxRecipients >= op.payload.audience.length;
    if (s.kind === 'model')
        return s.maxUnitsPerRun >= op.reservationUnits && s.maxSteps >= op.maxSteps;
    return false;
}
async function authority(ctx: Ctx, a: Doc<'actors'>, op: Doc<'operations'>) {
    if (a.kind === 'human')
        return undefined;
    const gs = await validGrants(ctx, a, op.capability);
    const candidates = gs.filter(g => (!op.grant || op.grant === g._id) && matches(g, op));
    const grant = candidates.find(g => g.mode === 'direct') ?? candidates[0];
    return grant ?? deny('authority denied');
}
async function checked(ctx: Ctx, op: Doc<'operations'>) {
    if (op.cancelRequestedAt !== undefined || op.absence?.finality === 'final')
        deny('cancellation requested');
    const a = await ctx.db.get(op.actor);
    if (!a || a.state !== 'active' || a.epoch !== op.actorEpoch)
        deny('authority epoch');
    await writable(ctx, op.org);
    const binding = await ctx.db.get(op.binding);
    if (!binding || binding.org !== op.org || !binding.healthy || binding.account !== op.payload.destination)
        deny('binding unavailable');
    const g = await authority(ctx, a, op), ap = op.approval;
    if (!ap || ap.expires <= Date.now() || ap.version !== op.version || ap.actorEpoch !== a.epoch || !same(ap.snapshot, op.payload))
        deny('approval changed/expired');
    if ('grant' in ap.approver && (!g || g._id !== ap.approver.grant || g.mode !== 'direct'))
        deny('direct authority revoked');
    if (op.payload.audience.length > 1 || op.step > op.maxSteps)
        deny('exposure bound');
    if (op.capability === 'marketing.send')
        for (const recipient of op.payload.audience) {
            const c = await ctx.db.query('consent').withIndex('recipient', q => q.eq('org', op.org).eq('recipient', recipient).eq('purpose', 'marketing').eq('channel', 'email')).unique();
            if (!c || c.suppressed)
                deny('consent denied');
        }
    return { a, grant: g?._id };
}
function unresolved(op: Doc<'operations'>) {
    return op.absence?.finality !== 'final' && (op.consumedPermits ?? []).some(p => !(op.receipts ?? []).some(r => r.step === p.step));
}
async function release(ctx: MutationCtx, op: Doc<'operations'>) {
    const current = await ctx.db.get(op._id);
    if (!current || current.released || unresolved(current) || (current.receipts ?? []).some(r => r.usage === undefined))
        return;
    if (current.reserved > 0) {
        const org = await ctx.db.get(current.org);
        if (!org)
            deny('org missing');
        const global = await ctx.db.get(org.budget);
        if (!global)
            deny('budget missing');
        const remaining = Math.max(0, current.reserved - current.usage);
        await ctx.db.patch(org._id, { reserved: org.reserved - remaining, active: org.active - 1 });
        await ctx.db.patch(global._id, { reserved: global.reserved - remaining, active: global.active - 1 });
    }
    await ctx.db.patch(current._id, { released: true, settled: true });
}
async function missingUsage(ctx: MutationCtx, orgId: Id<'orgs'>) {
    const operations = await ctx.db.query('operations').filter(q => q.eq(q.field('org'), orgId)).collect();
    await ctx.db.patch(orgId, { missingUsage: operations.some(op => (op.receipts ?? []).some(receipt => receipt.usage === undefined)) });
}
async function anomaly(ctx: MutationCtx, op: Doc<'operations'>, reason: string) {
    await ctx.db.patch(op._id, { anomaly: reason });
    await ctx.db.patch(op.org, { anomaly: reason });
    await audit(ctx, op.org, 'trusted-adapter', 'anomaly:' + reason, op._id);
}
async function sweep(ctx: MutationCtx, org: Id<'orgs'>) {
    for (const op of await ctx.db.query('operations').filter(q => q.eq(q.field('org'), org)).collect()) {
        if (['confirmed', 'cancelled', 'refused', 'outcomeUnknown'].includes(op.state))
            continue;
        const a = await ctx.db.get(op.actor);
        let revoked = !a || a.state !== 'active' || a.epoch !== op.actorEpoch;
        if (a && !revoked) {
            const related = await ctx.db.query('grants').filter(q => q.and(q.eq(q.field('actor'), a._id), q.eq(q.field('capability'), op.capability))).collect();
            if (op.grant || related.length) {
                try {
                    await authority(ctx, a, op);
                }
                catch {
                    revoked = true;
                }
            }
        }
        if (revoked) {
            const inflight = ['dispatching', 'cancellationPending'].includes(op.state);
            await ctx.db.patch(op._id, { state: unresolved(op) ? 'outcomeUnknown' : inflight ? 'cancellationPending' : 'paused', approval: inflight ? op.approval : undefined });
            if (!inflight && !unresolved(op) && op.reserved && !op.settled)
                await release(ctx, op);
        }
    }
}
export const seed = internalMutation({ args: { run: v.string(), tokens: v.array(v.string()) }, handler: async (ctx, { run, tokens }) => {
        if (tokens.length !== 10 || new Set(tokens).size !== 10)
            deny('ten independent session tokens required');
        if ((await ctx.db.query('orgs').filter(q => q.eq(q.field('name'), run + 'A')).collect()).length)
            deny('fixture namespace collision');
        let tokenIndex = 0;
        const result: Record<string, unknown> = {}, budget = await ctx.db.insert('budgets', { cap: 15, reserved: 0, spent: 0, maxConcurrent: 3, active: 0 });
        for (const name of ['A', 'B']) {
            const org = await ctx.db.insert('orgs', { name: run + name, budget, missingUsage: false, readonly: false, cap: 10, reserved: 0, spent: 0, maxConcurrent: 2, active: 0 }), actors: Record<string, string> = {}, sessions: Record<string, string> = {};
            for (const who of ['owner', 'manager', 'child', 'restricted']) {
                const id = await ctx.db.insert('actors', { org, name: who, kind: who === 'owner' ? 'human' : 'agent', state: 'active', epoch: 1 });
                const token = tokens[tokenIndex++];
                await ctx.db.insert('sessions', { actor: id, token });
                actors[who] = id;
                sessions[who] = token;
            }
            const key = { provider: 'fake:' + run, environment: 'SIM', account: name };
            const binding = await ctx.db.insert('bindings', { org, ...key, kind: 'contact', externalId: '1', local: 'recipient', healthy: true });
            const adapterToken = tokens[tokenIndex++];
            await ctx.db.insert('sessions', { token: adapterToken, adapterScope: key });
            await ctx.db.insert('consent', { org, recipient: 'recipient', purpose: 'marketing', channel: 'email', suppressed: false, version: 1, source: 'synthetic fixture', at: Date.now() });
            const bindingY = await ctx.db.insert('bindings', { org, ...key, kind: 'contact', externalId: '2', local: 'recipient-Y', healthy: true });
            await ctx.db.insert('consent', { org, recipient: 'recipient-Y', purpose: 'marketing', channel: 'email', suppressed: false, version: 1, source: 'synthetic fixture', at: Date.now() });
            const record = await ctx.db.insert('records', { org, object: 'person', public: 'visible ' + name, secret: 'SECRET-' + name });
            const invoice = await ctx.db.insert('records', { org, object: 'invoice', public: 'invoice ' + name, secret: 'INVOICE-SECRET-' + name });
            result[name] = { org, actors, sessions, binding, bindingY, adapter: adapterToken, record, invoice, key };
        }
        return result;
    } });
export const grant = mutation({ args: { token: v.string(), target: v.id('actors'), parent: v.optional(v.id('grants')), capability, scope, mode: v.union(v.literal('propose'), v.literal('direct')), delegate: v.boolean(), expires: v.number() }, handler: async (ctx, args) => {
        const a = await actor(ctx, args.token), target = await own(a, await ctx.db.get(args.target));
        if (target.kind === 'human' || target.state !== 'active' || target._id === a._id)
            deny('grant target denied');
        const s = args.scope;
        if ((args.capability === 'read') !== (s.kind === 'records') || (args.capability === 'model.call') !== (s.kind === 'model') || (args.capability === 'agent.manage') !== (s.kind === 'agents'))
            deny('scope/capability mismatch');
        if (s.kind === 'bindings') {
            if (!Number.isSafeInteger(s.maxAmountMinor) || s.maxAmountMinor < 0 || !positive(s.maxRecipients) || s.maxRecipients > 1)
                deny('invalid ceiling');
            for (const id of s.bindings)
                await own(a, await ctx.db.get(id));
        }
        if (s.kind === 'records' && s.records !== 'all')
            for (const id of s.records) {
                const r = await own(a, await ctx.db.get(id));
                if (r.object !== s.object)
                    deny('record object mismatch');
            }
        if (s.kind === 'model' && (!positive(s.maxUnitsPerRun) || !positive(s.maxSteps) || s.maxSteps > 5))
            deny('invalid model ceiling');
        if (s.kind === 'agents')
            for (const id of s.agents) {
                const t = await own(a, await ctx.db.get(id));
                if (t.kind === 'human' || id === a._id)
                    deny('manage target denied');
            }
        if (a.kind === 'agent') {
            await manage(ctx, a, target._id);
            if (!args.parent)
                deny('parent required');
            const p = await liveGrant(ctx, args.parent);
            if (p.actor !== a._id || p.capability !== args.capability || !p.delegate || !within(s, p.scope) || args.expires > p.expires || (args.mode === 'direct' && p.mode !== 'direct'))
                deny('delegation escalation');
            let lineage: Doc<'grants'> | null = p, depth = 0;
            while (lineage) {
                if (lineage.grantor === target._id || ++depth >= 8)
                    deny('ancestor grant denied');
                lineage = lineage.parent ? await ctx.db.get(lineage.parent) : null;
            }
        }
        const id = await ctx.db.insert('grants', { org: a.org, actor: target._id, grantor: a._id, grantorEpoch: a.epoch, parent: args.parent, capability: args.capability, scope: s, mode: args.mode, delegate: args.delegate, expires: args.expires });
        await audit(ctx, a.org, a._id, 'grant', id);
        return id;
    } });
export const propose = mutation({ args: { token: v.string(), logical: v.string(), binding: v.id('bindings'), capability, payload, reservationUnits: v.number(), maxSteps: v.number(), adoptedFrom: v.optional(v.id('operations')) }, handler: async (ctx, args) => {
        const a = await actor(ctx, args.token);
        await writable(ctx, a.org);
        const b = await own(a, await ctx.db.get(args.binding));
        if (args.payload.destination !== b.account)
            deny('destination substitution');
        if (!positive(args.reservationUnits) || !Number.isSafeInteger(args.payload.amountMinor) || args.payload.amountMinor < 0 || !positive(args.maxSteps) || args.maxSteps > 5 || (!['model.call'].includes(args.capability) && args.maxSteps !== 1))
            deny('invalid integer exposure');
        let author = a._id;
        if (args.adoptedFrom) {
            const source = await own(a, await ctx.db.get(args.adoptedFrom));
            if (a.kind !== 'human' || !['proposed', 'paused'].includes(source.state) || !same(source.payload, args.payload))
                deny('adoption denied');
            author = source.author;
        }
        const old = await ctx.db.query('operations').withIndex('logical', q => q.eq('org', a.org).eq('logical', args.logical)).unique();
        if (old) {
            if (old.actor !== a._id || old.binding !== b._id || old.capability !== args.capability || old.reservationUnits !== args.reservationUnits || old.maxSteps !== args.maxSteps || !same(old.payload, args.payload))
                deny('logical key collision');
            return old._id;
        }
        const id = await ctx.db.insert('operations', { org: a.org, author, actor: a._id, owner: a._id, adoptedFrom: args.adoptedFrom, capability: args.capability, logical: args.logical, binding: b._id, payload: args.payload, reservationUnits: args.reservationUnits, step: 1, maxSteps: args.maxSteps, usage: 0, version: 1, actorEpoch: a.epoch, state: 'proposed', fence: 0, leaseUntil: 0, permitUntil: 0, permitUsed: false, reserved: 0, settled: false, released: false, consumedPermits: [], receipts: [], late: false, attempts: 0 });
        await audit(ctx, a.org, a._id, 'proposed', id);
        return id;
    } });
export const approve = mutation({ args: { token: v.string(), id: v.id('operations'), expires: v.number() }, handler: async (ctx, args) => {
        const a = await actor(ctx, args.token), op = await own(a, await ctx.db.get(args.id));
        await writable(ctx, a.org);
        if (a.kind !== 'human' || !['proposed', 'approved'].includes(op.state))
            deny('approval denied');
        const owner = await ctx.db.get(op.actor);
        if (!owner || owner.state !== 'active' || owner.epoch !== op.actorEpoch)
            deny('stale actor');
        await ctx.db.patch(op._id, { approval: { snapshot: op.payload, version: op.version, expires: args.expires, actorEpoch: op.actorEpoch, approver: { actor: a._id } }, state: 'approved' });
        await audit(ctx, a.org, a._id, 'approved', op._id);
    } });
export const edit = mutation({ args: { token: v.string(), id: v.id('operations'), payload }, handler: async (ctx, args) => {
        const a = await actor(ctx, args.token), op = await own(a, await ctx.db.get(args.id));
        await writable(ctx, a.org);
        if (op.actor !== a._id || !['proposed', 'approved'].includes(op.state))
            deny('edit denied');
        if (args.payload.destination !== (await ctx.db.get(op.binding))?.account || !Number.isSafeInteger(args.payload.amountMinor) || args.payload.amountMinor < 0)
            deny('invalid edit');
        await ctx.db.patch(op._id, { payload: args.payload, version: op.version + 1, approval: undefined, state: 'proposed' });
        await audit(ctx, a.org, a._id, 'edited', op._id);
    } });
export const claim = mutation({ args: { token: v.string(), id: v.id('operations'), worker: v.string() }, handler: async (ctx, args) => {
        const a = await actor(ctx, args.token);
        let op = await own(a, await ctx.db.get(args.id));
        if (op.cancelRequestedAt !== undefined || op.absence?.finality === 'final')
            deny('cancellation requested');
        if (op.released)
            deny('operation released');
        if (op.actor !== a._id)
            deny('actor mismatch');
        if (!['proposed', 'approved', 'queued'].includes(op.state) || op.leaseUntil > Date.now())
            deny('not claimable');
        const g = await authority(ctx, a, op);
        if (op.state === 'proposed' && g?.mode === 'direct') {
            const approval = { snapshot: op.payload, version: op.version, expires: g.expires, actorEpoch: a.epoch, approver: { grant: g._id } };
            await ctx.db.patch(op._id, { approval, state: 'approved', grant: g._id });
            op = { ...op, approval, state: 'approved', grant: g._id };
        }
        if (op.state === 'proposed')
            deny('human approval required');
        const valid = await checked(ctx, op), org = await writable(ctx, op.org), global = await ctx.db.get(org.budget);
        if (!global)
            deny('global budget missing');
        if (org.anomaly)
            deny('operator anomaly hold');
        if (org.missingUsage)
            deny('usage unresolved');
        if (op.reservationUnits > 8)
            deny('per-run cap');
        if (op.reserved === 0) {
            if (org.active >= org.maxConcurrent)
                deny('concurrency cap');
            if (org.reserved + org.spent + op.reservationUnits > org.cap)
                deny('budget cap');
            if (global.active >= global.maxConcurrent || global.reserved + global.spent + op.reservationUnits > global.cap)
                deny('global budget/concurrency cap');
            await ctx.db.patch(org._id, { reserved: org.reserved + op.reservationUnits, active: org.active + 1 });
            await ctx.db.patch(global._id, { reserved: global.reserved + op.reservationUnits, active: global.active + 1 });
        }
        const fence = op.fence + 1;
        await ctx.db.patch(op._id, { grant: valid.grant, state: 'queued', fence, worker: args.worker, leaseUntil: Date.now() + 2000, reserved: op.reservationUnits, released: false, settled: false });
        await audit(ctx, op.org, a._id, 'claimed', op._id);
        return { fence, step: op.step };
    } });
export const permit = mutation({ args: { token: v.string(), id: v.id('operations'), fence: v.number(), step: v.number(), worker: v.string() }, handler: async (ctx, args) => {
        const op = await adapterOp(ctx, args.token, args.id);
        if (op.state !== 'queued' || op.fence !== args.fence || op.step !== args.step || op.worker !== args.worker || op.leaseUntil <= Date.now())
            deny('stale claim');
        await checked(ctx, op);
        const org = await ctx.db.get(op.org);
        if (!org)
            deny('org missing');
        if (org.anomaly)
            deny('operator anomaly hold');
        if (org.missingUsage)
            deny('usage unresolved');
        const maxUnits = op.reserved - op.usage;
        if (maxUnits <= 0)
            deny('exposure exhausted');
        if (op.payload.schedule > Date.now())
            deny('schedule not due');
        const active = await ctx.db.query('operations').filter(q => q.and(q.eq(q.field('org'), op.org), q.or(q.eq(q.field('state'), 'dispatching'), q.eq(q.field('state'), 'cancellationPending')))).collect();
        if (active.length >= 1)
            deny('outstanding permit cap');
        if (op.attempts >= 3)
            deny('retry limit');
        const expires = Date.now() + 1000;
        await ctx.db.patch(op._id, { state: 'dispatching', permitUntil: expires, permitUsed: false, attempts: op.attempts + 1 });
        await ctx.scheduler.runAfter(1001, internal.harness.expireInternal, { id: op._id, fence: op.fence, step: op.step });
        await ctx.scheduler.runAfter(Math.max(1, op.leaseUntil - Date.now() + 1), internal.harness.expireInternal, { id: op._id, fence: op.fence, step: op.step });
        await audit(ctx, op.org, 'trusted-adapter', 'permit', op._id);
        return { id: op._id, version: op.version, binding: op.binding, fence: op.fence, step: op.step, worker: op.worker, expires, maxUnits, maxRecipients: op.payload.audience.length };
    } });
export const consume = mutation({ args: { token: v.string(), id: v.id('operations'), fence: v.number(), step: v.number(), worker: v.string(), version: v.number(), binding: v.id('bindings') }, handler: async (ctx, args) => {
        const op = await adapterOp(ctx, args.token, args.id);
        if (!['dispatching', 'cancellationPending'].includes(op.state) || op.permitUsed || op.permitUntil <= Date.now() || op.fence !== args.fence || op.step !== args.step || op.worker !== args.worker || op.version !== args.version || op.binding !== args.binding)
            deny('invalid or spent permit');
        const permits = op.consumedPermits ?? [];
        if (permits.length >= 15)
            deny('consumed permit bound');
        await ctx.db.patch(op._id, { permitUsed: true, consumedPermits: [...permits, { fence: op.fence, step: op.step }] });
        return { providerKey: op.binding, key: op.logical + ':step:' + op.step, account: op.payload.destination, payload: op.payload, maxUnits: op.reserved - op.usage, maxRecipients: op.payload.audience.length };
    } });
export const adapterStatus = query({ args: { token: v.string(), id: v.id('operations'), fence: v.number(), step: v.number() }, handler: async (ctx, args) => {
        const op = await adapterOp(ctx, args.token, args.id);
        if (!(op.fence === args.fence && op.step === args.step) && !(op.consumedPermits ?? []).some(p => p.fence === args.fence && p.step === args.step))
            deny('stale status');
        let cancel = op.cancelRequestedAt !== undefined || op.leaseUntil <= Date.now() || ['paused', 'cancelled', 'refused', 'confirmed'].includes(op.state);
        try {
            await checked(ctx, op);
        }
        catch {
            cancel = true;
        }
        return { state: op.state, cancel };
    } });
export const unknown = mutation({ args: { token: v.string(), id: v.id('operations'), fence: v.number(), step: v.number() }, handler: async (ctx, args) => {
        const op = await adapterOp(ctx, args.token, args.id);
        if (op.fence !== args.fence || op.step !== args.step || !['dispatching', 'cancellationPending', 'outcomeUnknown'].includes(op.state))
            deny('stale outcome');
        if (op.state === 'outcomeUnknown' || !op.permitUsed)
            return;
        await ctx.db.patch(op._id, { state: 'outcomeUnknown' });
        await audit(ctx, op.org, 'trusted-adapter', 'outcomeUnknown', op._id);
    } });
export const reconcile = mutation({ args: { token: v.string(), id: v.id('operations'), fence: v.number(), step: v.number(), providerRef: v.string(), usage: v.optional(v.number()), continue: v.optional(v.boolean()) }, handler: async (ctx, args) => {
        const op = await adapterOp(ctx, args.token, args.id);
        if (!(op.consumedPermits ?? []).some(p => p.fence === args.fence && p.step === args.step))
            deny('stale/unpermitted outcome');
        const receipts = op.receipts ?? [], existing = receipts.find(r => r.step === args.step);
        if (existing && existing.providerRef !== args.providerRef) {
            await anomaly(ctx, op, 'provider result collision');
            return { accepted: false, error: 'provider result collision' };
        }
        if (existing && (existing.usage !== undefined || args.usage === undefined))
            return { accepted: true, duplicate: true };
        if (args.usage !== undefined && (!Number.isSafeInteger(args.usage) || args.usage < 0))
            deny('invalid authoritative usage');
        const continuing = !!args.continue && ['dispatching', 'cancellationPending', 'outcomeUnknown'].includes(op.state) && op.step === args.step && args.usage !== undefined && op.capability === 'model.call' && op.step < op.maxSteps;
        const a = await ctx.db.get(op.actor);
        let revoked = !a || a.state !== 'active' || a.epoch !== op.actorEpoch;
        if (a && !revoked) {
            try {
                await authority(ctx, a, op);
            }
            catch {
                revoked = true;
            }
        }
        const cancelled = op.cancelRequestedAt !== undefined, late = revoked || cancelled || !!op.absence || !!op.released || op.late;
        const receipt = { step: args.step, providerRef: args.providerRef, usage: args.usage, late, at: existing?.at ?? Date.now() };
        const updated = existing ? receipts.map(r => r.step === args.step ? receipt : r) : [...receipts, receipt];
        const actual = args.usage ?? 0, total = op.usage + actual, overrun = total > op.reserved;
        if (args.usage !== undefined) {
            const org = await ctx.db.get(op.org);
            if (!org)
                deny('org missing');
            const global = await ctx.db.get(org.budget);
            if (!global)
                deny('budget missing');
            const spentReservation = op.released ? 0 : Math.min(actual, Math.max(0, op.reserved - op.usage));
            await ctx.db.patch(org._id, { spent: org.spent + actual, reserved: org.reserved - spentReservation });
            await ctx.db.patch(global._id, { spent: global.spent + actual, reserved: global.reserved - spentReservation });
        }
        await ctx.db.patch(op._id, { receipts: updated, usage: total, providerRef: args.providerRef, late, overrun: op.overrun || overrun });
        if (op.released && !existing)
            await anomaly(ctx, op, op.absence?.finality === 'final' ? 'acceptedAfterFinalAbsence' : 'acceptedAfterRelease');
        if (overrun) {
            await anomaly(ctx, op, 'usageOverrun');
            await ctx.db.patch(op._id, { state: continuing ? 'paused' : 'confirmed', cancelRequestedAt: op.cancelRequestedAt ?? Date.now() });
            await release(ctx, op);
        }
        else if (continuing && total < op.reserved && !revoked && !cancelled && !op.released) {
            await ctx.db.patch(op._id, { state: 'queued', step: op.step + 1, fence: op.fence + 1, worker: undefined, leaseUntil: 0, permitUsed: false });
        }
        else {
            await ctx.db.patch(op._id, { state: args.continue && (cancelled || revoked) ? (cancelled ? 'cancelled' : 'paused') : 'confirmed' });
            if (args.usage !== undefined)
                await release(ctx, op);
        }
        await missingUsage(ctx, op.org);
        await audit(ctx, op.org, 'trusted-adapter', cancelled ? (revoked ? 'completedAfterCancellationAndRevocation' : 'completedAfterCancellation') : revoked ? 'completedAfterRevocation' : op.absence ? 'completedAfterAbsence' : 'confirmed', op._id);
        return { accepted: true, late, overrun, ...(args.continue && (!continuing || total >= op.reserved || overrun || cancelled || revoked || op.released) ? { continuationRefused: true } : {}) };
    } });
export const fail = mutation({ args: { token: v.string(), id: v.id('operations'), fence: v.number(), step: v.number(), retryable: v.boolean() }, handler: async (ctx, args) => {
        const op = await adapterOp(ctx, args.token, args.id);
        if (['cancelled', 'refused', 'outcomeUnknown'].includes(op.state))
            return;
        if (op.fence !== args.fence || op.step !== args.step || !['dispatching', 'cancellationPending'].includes(op.state))
            deny('stale failure');
        // A failure report is not proof that a consumed provider attempt incurred no cost.
        const pending = unresolved(op), cancelled = op.cancelRequestedAt !== undefined, retry = args.retryable && op.attempts < 3 && !cancelled && !pending;
        await ctx.db.patch(op._id, { state: pending ? 'outcomeUnknown' : cancelled ? 'cancelled' : retry ? 'queued' : 'refused', fence: op.fence + 1, worker: undefined, leaseUntil: 0, permitUsed: false });
        if (!retry && !pending)
            await release(ctx, op);
        await audit(ctx, op.org, 'trusted-adapter', pending ? 'outcomeUnknown' : retry ? 'retryableRejection' : 'terminalRejection', op._id);
    } });
export const resolveUnknown = mutation({ args: { token: v.string(), id: v.id('operations'), fence: v.number(), step: v.number(), absent: v.literal(true), finality: v.union(v.literal('provisional'), v.literal('final')) }, handler: async (ctx, args) => {
        const s = await session(ctx, args.token);
        const op = await ctx.db.get(args.id);
        if (!op)
            deny('operation unknown');
        let by: 'adapter' | Id<'actors'> = 'adapter';
        if (s.adapterScope)
            await adapterOp(ctx, args.token, args.id);
        else {
            const a = await actor(ctx, args.token);
            await own(a, op);
            if (a.kind !== 'human')
                deny('operator only');
            by = a._id;
        }
        if (op.absence?.finality === 'final')
            return;
        if (op.state !== 'outcomeUnknown' || !(op.consumedPermits ?? []).some(p => p.fence === args.fence && p.step === args.step))
            deny('not unknown');
        const absence = { finality: args.finality, by, at: Date.now() };
        let valid = true;
        try {
            await checked(ctx, op);
        }
        catch {
            valid = false;
        }
        // A real adapter must prove finality; no elapsed fixture timer manufactures it.
        if (args.finality === 'final') {
            await ctx.db.patch(op._id, { absence, state: op.cancelRequestedAt !== undefined ? 'cancelled' : 'refused' });
            await release(ctx, op);
        }
        else
            await ctx.db.patch(op._id, { absence, state: valid ? 'queued' : 'outcomeUnknown', fence: valid ? op.fence + 1 : op.fence, worker: undefined, leaseUntil: 0, permitUsed: false });
        await audit(ctx, op.org, by, 'authoritativeAbsence:' + args.finality, op._id);
    } });
async function expireOperation(ctx: MutationCtx, op: Doc<'operations'>) {
    if (!['dispatching', 'cancellationPending'].includes(op.state) || op.permitUntil > Date.now() || (op.permitUsed && op.leaseUntil > Date.now()))
        return;
    let state: 'queued' | 'paused' | 'cancelled' = op.cancelRequestedAt !== undefined ? 'cancelled' : 'queued';
    if (!op.permitUsed && state === 'queued') {
        try {
            await checked(ctx, op);
        }
        catch {
            state = 'paused';
        }
    }
    const pending = unresolved(op);
    await ctx.db.patch(op._id, pending ? { state: 'outcomeUnknown' } : { state, fence: op.fence + 1, worker: undefined, leaseUntil: 0 });
    if (!pending && state !== 'queued')
        await release(ctx, op);
    await audit(ctx, op.org, 'system-expiry', pending ? 'outcomeUnknown' : 'unconsumedPermitExpired', op._id);
}
export const expireInternal = internalMutation({ args: { id: v.id('operations'), fence: v.number(), step: v.number() }, handler: async (ctx, args) => { const op = await ctx.db.get(args.id); if (op && op.fence === args.fence && op.step === args.step)
        await expireOperation(ctx, op); } });
export const expire = mutation({ args: { token: v.string(), id: v.id('operations') }, handler: async (ctx, args) => { await expireOperation(ctx, await adapterOp(ctx, args.token, args.id)); } });
export const revoke = mutation({ args: { token: v.string(), target: v.id('actors') }, handler: async (ctx, args) => {
        const a = await actor(ctx, args.token), target = await own(a, await ctx.db.get(args.target));
        if (target.kind === 'human' || target._id === a._id)
            deny('cannot manage human/self');
        await manage(ctx, a, target._id);
        await ctx.db.patch(target._id, { epoch: target.epoch + 1, state: 'fired' });
        await sweep(ctx, a.org);
        await audit(ctx, a.org, a._id, 'fired', target._id);
    } });
export const revokeGrant = mutation({ args: { token: v.string(), id: v.id('grants') }, handler: async (ctx, args) => {
        const a = await actor(ctx, args.token), g = await own(a, await ctx.db.get(args.id));
        await manage(ctx, a, g.actor);
        if (a.kind !== 'human' && g.grantor !== a._id)
            deny('not own delegation');
        await ctx.db.patch(g._id, { revokedAt: Date.now() });
        const target = await ctx.db.get(g.actor);
        if (target)
            await ctx.db.patch(target._id, { epoch: target.epoch + 1 });
        await sweep(ctx, a.org);
        await audit(ctx, a.org, a._id, 'grantRevoked', g._id);
    } });
export const cancel = mutation({ args: { token: v.string(), id: v.id('operations') }, handler: async (ctx, args) => {
        const a = await actor(ctx, args.token), op = await own(a, await ctx.db.get(args.id));
        if (a.kind !== 'human' && op.actor !== a._id)
            deny('cancel denied');
        if (op.cancelRequestedAt !== undefined)
            return;
        const inflight = ['dispatching', 'cancellationPending'].includes(op.state), pending = unresolved(op);
        const state = op.state === 'confirmed' ? 'confirmed' : ['refused', 'cancelled'].includes(op.state) ? 'cancelled' : inflight ? 'cancellationPending' : op.state === 'outcomeUnknown' || pending ? 'outcomeUnknown' : 'cancelled';
        await ctx.db.patch(op._id, { cancelRequestedAt: Date.now(), state });
        if (!inflight && !pending)
            await release(ctx, op);
        await audit(ctx, a.org, a._id, 'cancellationRequested', op._id);
    } });
export const control = mutation({ args: { token: v.string(), readonly: v.optional(v.boolean()), suppress: v.optional(v.boolean()), recipient: v.optional(v.string()), clearAnomaly: v.optional(v.boolean()), healthy: v.optional(v.boolean()), binding: v.optional(v.id('bindings')) }, handler: async (ctx, args) => {
        const a = await actor(ctx, args.token);
        if (a.kind !== 'human')
            deny('owner only');
        if (args.readonly !== undefined)
            await ctx.db.patch(a.org, { readonly: args.readonly });
        if (args.healthy !== undefined && args.binding) {
            const b = await own(a, await ctx.db.get(args.binding));
            await ctx.db.patch(b._id, { healthy: args.healthy });
        }
        if (args.clearAnomaly)
            await ctx.db.patch(a.org, { anomaly: undefined });
        if (args.suppress !== undefined) {
            if (!args.recipient)
                deny('recipient required');
            const c = await ctx.db.query('consent').withIndex('recipient', q => q.eq('org', a.org).eq('recipient', args.recipient!).eq('purpose', 'marketing').eq('channel', 'email')).unique();
            if (c)
                await ctx.db.patch(c._id, { suppressed: args.suppress, version: c.version + 1, at: Date.now() });
        }
        await audit(ctx, a.org, a._id, 'control', a.org);
    } });
export const operation = query({ args: { token: v.string(), id: v.id('operations') }, handler: async (ctx, args) => {
        const a = await actor(ctx, args.token), op = await own(a, await ctx.db.get(args.id));
        if (a.kind !== 'human' && op.actor !== a._id)
            deny('operation scope denied');
        if (a.kind === 'human')
            return op;
        // Unstructured content cannot be field-masked. Agents read drafts through the scoped facade.
        return { _id: op._id, actor: op.actor, author: op.author, owner: op.owner, state: op.state, step: op.step, late: op.late };
    } });
async function masks(ctx: Ctx, a: Doc<'actors'>, r: Doc<'records'>) {
    if (a.kind === 'human')
        return ['public', 'secret'];
    const gs = await validGrants(ctx, a, 'read');
    return [...new Set(gs.flatMap(g => { const s = g.scope; return s.kind === 'records' && s.object === r.object && (s.records === 'all' || s.records.includes(r._id)) ? s.fields : []; }))];
}
export const read = query({ args: { token: v.string(), surface: v.union(...['record', 'history', 'suggestion', 'export', 'report', 'MCP', 'REST', 'search', 'file', 'provider', 'subscription'].map(x => v.literal(x))), filterField: v.optional(v.string()), sortField: v.optional(v.string()), groupField: v.optional(v.string()), record: v.optional(v.id('records')) }, handler: async (ctx, args) => {
        const a = await actor(ctx, args.token), rows = args.record ? [await own(a, await ctx.db.get(args.record))] : await ctx.db.query('records').filter(q => q.eq(q.field('org'), a.org)).collect();
        const result = [];
        for (const r of rows) {
            const fields = await masks(ctx, a, r);
            if (!fields.length)
                continue;
            for (const field of [args.filterField, args.sortField, args.groupField])
                if (field && !fields.includes(field))
                    deny('masked inference');
            const source = { public: r.public, secret: r.secret }, visible = project(source, fields);
            switch (args.surface) {
                case 'history':
                    result.push({ before: project({ ...source, public: 'old ' + r.public }, fields), after: visible });
                    break;
                case 'suggestion':
                    result.push({ proposed: visible });
                    break;
                case 'report':
                    result.push({ group: project(source, args.groupField ? [args.groupField] : fields), count: 1 });
                    break;
                case 'MCP':
                case 'REST':
                    result.push({ data: visible });
                    break;
                case 'file':
                    result.push({ contents: JSON.stringify(visible) });
                    break;
                case 'provider':
                    result.push({ providerOutput: visible });
                    break;
                case 'subscription':
                    result.push({ current: visible });
                    break;
                default: result.push(visible);
            }
        }
        return result;
    } });
export const callback = mutation({ args: { token: v.string(), binding: v.id('bindings'), eventId: v.string(), body: v.string(), observed: v.optional(v.object({ version: v.number(), state: v.string(), channel: v.string(), purpose: v.string() })) }, handler: async (ctx, args) => {
        const b = await ctx.db.get(args.binding);
        if (!b)
            deny('binding unknown');
        await adapter(ctx, args.token, b);
        const data: unknown = JSON.parse(args.body);
        if (!data || typeof data !== 'object' || !('version' in data) || !('state' in data) || !Number.isSafeInteger(data.version) || typeof data.state !== 'string')
            deny('invalid callback body');
        const version = args.observed?.version ?? data.version as number, state = args.observed?.state ?? data.state;
        const channel = args.observed?.channel ?? ('channel' in data ? data.channel : undefined), purpose = args.observed?.purpose ?? ('purpose' in data ? data.purpose : undefined);
        if (!Number.isSafeInteger(version))
            deny('invalid observed version');
        const prior = await ctx.db.query('callbacks').withIndex('key', q => q.eq('binding', b._id).eq('eventId', args.eventId)).unique();
        if (prior) {
            if (prior.digest !== args.body)
                deny('callback integrity');
            return 'duplicate';
        }
        await ctx.db.insert('callbacks', { binding: b._id, eventId: args.eventId, digest: args.body });
        const observation = await ctx.db.query('observations').filter(q => q.eq(q.field('binding'), b._id)).unique();
        if (!observation || version > observation.version) {
            if (observation)
                await ctx.db.patch(observation._id, { version, state });
            else
                await ctx.db.insert('observations', { binding: b._id, version, state });
            const c = await ctx.db.query('consent').withIndex('recipient', q => q.eq('org', b.org).eq('recipient', b.local).eq('purpose', typeof purpose === 'string' ? purpose : '').eq('channel', typeof channel === 'string' ? channel : '')).unique();
            if (state === 'suppressed') {
                if (typeof purpose !== 'string' || typeof channel !== 'string')
                    deny('consent purpose/channel required');
                const suppression = { suppressed: true, version: (c?.version ?? 0) + 1, source: 'authenticated SIM provider', at: Date.now() };
                if (c)
                    await ctx.db.patch(c._id, suppression);
                else
                    await ctx.db.insert('consent', { org: b.org, recipient: b.local, purpose, channel, ...suppression });
            }
        }
        await audit(ctx, b.org, 'trusted-adapter', 'callback', b._id);
        return 'applied';
    } });
export const provision = mutation({ args: { token: v.string(), binding: v.id('bindings'), intent: v.string(), remove: v.boolean(), externalId: v.optional(v.string()) }, handler: async (ctx, args) => {
        const s = await session(ctx, args.token), b = await ctx.db.get(args.binding);
        if (!b)
            deny('binding unknown');
        if (s.adapterScope)
            await adapter(ctx, args.token, b);
        else {
            const a = await actor(ctx, args.token);
            await own(a, b);
            if (a.kind !== 'human')
                deny('owner only');
            if (args.externalId)
                deny('adapter-only result');
        }
        const existing = await ctx.db.query('provisions').filter(q => q.and(q.eq(q.field('binding'), b._id), q.eq(q.field('intent'), args.intent))).unique();
        await audit(ctx, b.org, s.actor ?? 'trusted-adapter', 'provision', args.intent);
        if (!existing) {
            if (args.externalId)
                deny('intent required first');
            return ctx.db.insert('provisions', { org: b.org, binding: b._id, intent: args.intent, deleted: args.remove, cleanup: false });
        }
        if (args.externalId && existing.externalId && args.externalId !== existing.externalId)
            deny('duplicate external create');
        const deleted = existing.deleted || args.remove;
        await ctx.db.patch(existing._id, { deleted, externalId: args.externalId ?? existing.externalId, cleanup: deleted && !!(args.externalId ?? existing.externalId) });
        return existing._id;
    } });
export const bind = mutation({ args: { token: v.string(), intent: v.id('provisions'), kind: v.string(), externalId: v.string(), local: v.string() }, handler: async (ctx, args) => {
        const intent = await ctx.db.get(args.intent);
        if (!intent || intent.deleted)
            deny('intent missing/deleted');
        const base = await ctx.db.get(intent.binding);
        if (!base || intent.org !== base.org)
            deny('intent tenant mismatch');
        await adapter(ctx, args.token, base);
        const prior = await ctx.db.query('bindings').withIndex('key', q => q.eq('provider', base.provider).eq('environment', base.environment).eq('account', base.account).eq('kind', args.kind).eq('externalId', args.externalId)).unique();
        if (prior) {
            if (prior.org !== intent.org || prior.local !== args.local)
                deny('binding collision');
            return prior._id;
        }
        await audit(ctx, intent.org, 'trusted-adapter', 'bound', args.externalId);
        return ctx.db.insert('bindings', { org: intent.org, provider: base.provider, environment: base.environment, account: base.account, kind: args.kind, externalId: args.externalId, local: args.local, healthy: true });
    } });
export const page = mutation({ args: { token: v.string(), binding: v.id('bindings'), traversal: v.string(), from: v.number(), page: v.number(), items: v.array(v.string()), end: v.boolean(), checkpoint: v.number() }, handler: async (ctx, args) => {
        const b = await ctx.db.get(args.binding);
        if (!b)
            deny('binding unknown');
        await adapter(ctx, args.token, b);
        let cursor = await ctx.db.query('cursors').filter(q => q.eq(q.field('binding'), b._id)).unique();
        if (!cursor) {
            if (args.from !== 0)
                deny('checkpoint mismatch');
            const id = await ctx.db.insert('cursors', { binding: b._id, checkpoint: 0, traversal: args.traversal, page: 0, items: [], complete: false });
            cursor = await ctx.db.get(id);
        }
        if (!cursor)
            deny('cursor missing');
        if (cursor.traversal !== args.traversal) {
            if (!cursor.complete || args.from !== cursor.checkpoint || args.page !== 1)
                deny('traversal checkpoint mismatch');
            cursor = { ...cursor, traversal: args.traversal, page: 0, complete: false };
        }
        if (args.checkpoint < cursor.checkpoint || args.page > cursor.page + 1)
            deny('partial traversal gap/regression');
        if (args.page <= cursor.page)
            return cursor.checkpoint;
        await ctx.db.patch(cursor._id, { traversal: cursor.traversal, page: args.page, items: [...new Set([...cursor.items, ...args.items])], checkpoint: args.end ? args.checkpoint : cursor.checkpoint, complete: args.end });
        await audit(ctx, b.org, 'trusted-adapter', 'cursorPage', b._id);
        return args.end ? args.checkpoint : cursor.checkpoint;
    } });
export const dump = internalQuery({ args: { orgs: v.array(v.id('orgs')) }, handler: async (ctx, { orgs }) => {
        const result: Record<string, unknown> = {}, selected = new Set(orgs);
        const orgRows = await Promise.all(orgs.map(id => ctx.db.get(id)));
        const budgets = new Set(orgRows.flatMap(o => o ? [o.budget] : []));
        const bindingRows = await ctx.db.query('bindings').collect();
        const bindings = new Set(bindingRows.filter(b => selected.has(b.org)).map(b => b._id));
        for (const table of ['budgets', 'orgs', 'actors', 'grants', 'bindings', 'operations', 'consent', 'events', 'callbacks', 'observations', 'provisions', 'cursors', 'records'] as const) {
            const rows = await ctx.db.query(table).collect();
            result[table] = rows.filter(row => ('org' in row && selected.has(row.org)) || ('budget' in row && selected.has(row._id)) || budgets.has(row._id as Id<'budgets'>) || ('binding' in row && bindings.has(row.binding)));
        }
        return result;
    } });
