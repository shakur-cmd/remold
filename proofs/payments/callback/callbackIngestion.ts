import { mutation, query, internalMutation } from './_generated/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { ConvexError, v } from 'convex/values';
// Additive to the frozen payments module. Every refusal the drain acts on is a ConvexError code or a typed
// return value, because production Convex hides the message of any other error.
const MAX_ATTEMPTS = 5, WINDOW = 100, SCAN = 1000, PARK_CAP = 500;
const fail = (code: string): never => { throw new ConvexError({ code }); };
const CODE = /^[a-z0-9_]{1,60}$/, ACCOUNT = /^acct_[A-Za-z0-9]{1,64}$/;
async function adapter(ctx: MutationCtx | QueryCtx, token: string, binding: Id<'bindings'>) {
    const b = await ctx.db.get(binding), s = await ctx.db.query('sessions').withIndex('token', q => q.eq('token', token)).unique(), a = s?.adapterScope;
    if (!b || !a || a.provider !== b.provider || a.environment !== b.environment || a.account !== b.account) fail('adapter_denied');
    return b!;
}
async function receipt(ctx: MutationCtx | QueryCtx, token: string, id: Id<'payIncoming'>) {
    const row = await ctx.db.get(id);
    if (!row) fail('receipt_missing');
    return { row: row!, binding: await adapter(ctx, token, row!.binding) };
}
const hash = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(n => n.toString(16).padStart(2, '0')).join('');

// Measurement read: one event's rows, or the newest rows. Never throws on volume.
export const receipts = query({ args: { token: v.string(), binding: v.id('bindings'), eventId: v.optional(v.string()), limit: v.optional(v.number()) }, handler: async (ctx, a) => {
    await adapter(ctx, a.token, a.binding);
    const limit = Math.max(1, Math.min(a.limit ?? 100, 1000));
    let rows;
    if (a.eventId !== undefined) rows = await ctx.db.query('payIncoming').withIndex('event', q => q.eq('binding', a.binding).eq('eventId', a.eventId!)).take(limit);
    else {
        // Newest first by creation: merge the newest open and newest closed rows.
        const newest = (done: boolean) => ctx.db.query('payIncoming').withIndex('pending', q => q.eq('binding', a.binding).eq('done', done)).order('desc').take(limit);
        rows = [...await newest(false), ...await newest(true)].sort((x, y) => y._creationTime - x._creationTime).slice(0, limit);
    }
    return rows.map(({ eventId, type, externalId, digest, done }) => ({ eventId, type, externalId, digest, done }));
} });

// Open receipts that are due, oldest first. Receipts waiting out a backoff are skipped so they cannot starve newer ones.
export const due = query({ args: { token: v.string(), binding: v.id('bindings'), now: v.number() }, handler: async (ctx, a) => {
    await adapter(ctx, a.token, a.binding);
    const items = [];
    let scanned = 0;
    for await (const row of ctx.db.query('payIncoming').withIndex('pending', q => q.eq('binding', a.binding).eq('done', false))) {
        if (++scanned > SCAN || items.length >= WINDOW) break;
        const retry = await ctx.db.query('callbackRetries').withIndex('incoming', q => q.eq('incoming', row._id)).unique();
        if (retry && retry.nextAt > a.now) continue;
        items.push({ id: row._id, eventId: row.eventId, type: row.type, externalId: row.externalId, attempts: retry?.attempts ?? 0 });
    }
    return items;
} });

// Typed decision before any provider read. Only invoice events for an invoice this binding owns are re-read.
export const prepare = query({ args: { token: v.string(), id: v.id('payIncoming') }, handler: async (ctx, a) => {
    const { row } = await receipt(ctx, a.token, a.id);
    if (!row.type.startsWith('invoice.')) return { action: 'refuse' as const, code: 'unsupported_event_type' };
    const doc = await ctx.db.query('documents').withIndex('external', q => q.eq('binding', row.binding).eq('externalId', row.externalId)).unique();
    if (!doc) return { action: 'refuse' as const, code: 'unbound_document' };
    return { action: 'reconcile' as const };
} });

export const refuse = mutation({ args: { token: v.string(), id: v.id('payIncoming'), reason: v.string() }, handler: async (ctx, a) => {
    const { row, binding } = await receipt(ctx, a.token, a.id);
    if (!CODE.test(a.reason)) fail('invalid_code');
    if (row.done) return false;
    await ctx.db.patch(row._id, { done: true });
    await ctx.db.insert('events', { org: binding.org, actor: 'trusted-stripe-adapter', kind: 'payment.callback.refused:' + a.reason, resource: row._id, at: Date.now() });
    return true;
} });

// Retryable failure: count it and back off exponentially; the last allowed attempt closes the receipt as failed.
export const defer = mutation({ args: { token: v.string(), id: v.id('payIncoming'), code: v.string(), now: v.number(), backoffMs: v.number() }, handler: async (ctx, a) => {
    const { row, binding } = await receipt(ctx, a.token, a.id);
    if (!CODE.test(a.code)) fail('invalid_code');
    if (row.done) return { state: 'closed' as const, attempts: 0 };
    const retry = await ctx.db.query('callbackRetries').withIndex('incoming', q => q.eq('incoming', row._id)).unique();
    const attempts = (retry?.attempts ?? 0) + 1, nextAt = a.now + Math.max(0, a.backoffMs) * 2 ** (attempts - 1);
    if (retry) await ctx.db.patch(retry._id, { attempts, nextAt, code: a.code });
    else await ctx.db.insert('callbackRetries', { incoming: row._id, attempts, nextAt, code: a.code });
    if (attempts < MAX_ATTEMPTS) return { state: 'retry' as const, attempts, nextAt };
    await ctx.db.patch(row._id, { done: true });
    await ctx.db.insert('events', { org: binding.org, actor: 'trusted-stripe-adapter', kind: 'payment.callback.failed:' + a.code, resource: row._id, at: Date.now() });
    return { state: 'failed' as const, attempts };
} });

export const configureIngress = internalMutation({ args: { tokenHash: v.string() }, handler: async (ctx, a) => { await ctx.db.insert('callbackIngress', a); } });
async function ingress(ctx: MutationCtx | QueryCtx, token: string) {
    const tokenHash = await hash(token);
    if (!await ctx.db.query('callbackIngress').withIndex('token', q => q.eq('tokenHash', tokenHash)).first()) fail('ingress_denied');
}
async function alert(ctx: MutationCtx, kind: string, account: string, eventId: string) {
    const old = await ctx.db.query('callbackAlerts').withIndex('key', q => q.eq('kind', kind).eq('account', account)).unique(), at = Date.now();
    if (old) await ctx.db.patch(old._id, { count: old.count + 1, lastAt: at, lastEventId: eventId });
    else await ctx.db.insert('callbackAlerts', { kind, account, count: 1, firstAt: at, lastAt: at, lastEventId: eventId });
}

// Signed event for a connected account with no binding: keep a bounded, effect-free record and raise an alert.
// Nothing reads parked rows back as effects; binding a merchant starts its own full pull.
export const park = mutation({ args: { token: v.string(), account: v.string(), eventId: v.string(), type: v.string(), digest: v.string(), externalId: v.optional(v.string()) }, handler: async (ctx, a) => {
    await ingress(ctx, a.token);
    if (!ACCOUNT.test(a.account)) fail('invalid_account');
    for (const environment of ['SIM', 'SANDBOX'])
        if (await ctx.db.query('bindings').withIndex('key', q => q.eq('provider', 'stripe').eq('environment', environment).eq('account', a.account)).first()) fail('account_bound');
    if (await ctx.db.query('callbackParked').withIndex('key', q => q.eq('account', a.account).eq('eventId', a.eventId)).unique()) return { parked: false, duplicate: true };
    if ((await ctx.db.query('callbackParked').take(PARK_CAP)).length >= PARK_CAP) { await alert(ctx, 'park_overflow', a.account, a.eventId); return { parked: false, duplicate: false }; }
    await ctx.db.insert('callbackParked', { account: a.account, eventId: a.eventId, type: a.type, digest: a.digest, at: Date.now() });
    await alert(ctx, 'parked', a.account, a.eventId);
    return { parked: true, duplicate: false };
} });

export const parked = query({ args: { token: v.string() }, handler: async (ctx, a) => {
    await ingress(ctx, a.token);
    return { rows: (await ctx.db.query('callbackParked').take(PARK_CAP)).map(({ account, eventId, type }) => ({ account, eventId, type })), alerts: (await ctx.db.query('callbackAlerts').take(100)).map(({ kind, account, count }) => ({ kind, account, count })) };
} });
