import { mutation, query, internalMutation, action } from './_generated/server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { v } from 'convex/values';
type Ctx = MutationCtx | QueryCtx;
function deny(s: string): never { throw new Error(s); }
const hash = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(n => n.toString(16).padStart(2, '0')).join('');
const currency = v.union(v.literal('usd'), v.literal('eur'), v.literal('jpy'));
function money(n: number) { if (!Number.isSafeInteger(n) || n < 0 || n > 100000000)
    deny('integer minor units required'); return n; }
async function actor(ctx: Ctx, token: string) { const session = await ctx.db.query('sessions').withIndex('token', q => q.eq('token', token)).unique(); const a = session?.actor && await ctx.db.get(session.actor); if (!a || a.state !== 'active')
    deny('actor inactive'); return a; }
async function own<T extends {
    org: Id<'orgs'>;
}>(ctx: Ctx, token: string, row: T | null) { const a = await actor(ctx, token); if (!row || row.org !== a.org)
    deny('tenant denied'); return { a, row }; }
async function human(ctx: Ctx, token: string) { const a = await actor(ctx, token); if (a.kind !== 'human')
    deny('human finance authority required'); return a; }
async function writable(ctx: Ctx, org: Id<'orgs'>, binding: Id<'bindings'>) { const o = await ctx.db.get(org), b = await ctx.db.get(binding); if (o?.readonly)
    deny('readonly new issuance refused'); if (!b || b.org !== org || !b.healthy)
    deny('merchant restricted or disconnected'); }
async function adapter(ctx: Ctx, token: string, binding: Id<'bindings'>) { const b = await ctx.db.get(binding), s = await ctx.db.query('sessions').withIndex('token', q => q.eq('token', token)).unique(), a = s?.adapterScope; if (!b || !a || a.provider !== b.provider || a.environment !== b.environment || a.account !== b.account)
    deny('adapter account denied'); return b; }
async function audit(ctx: MutationCtx, org: Id<'orgs'>, who: string, kind: string, resource: string) { await ctx.db.insert('events', { org, actor: who, kind, resource, at: Date.now() }); }
export const configureFixture = internalMutation({ args: { binding: v.id('bindings'), adapterToken: v.string(), account: v.string(), environment: v.union(v.literal('SIM'), v.literal('SANDBOX')), healthy: v.boolean() }, handler: async (ctx, a) => {
        const b = await ctx.db.get(a.binding);
        if (!b)
            deny('missing binding');
        const session = await ctx.db.query('sessions').withIndex('token', q => q.eq('token', a.adapterToken)).unique();
        if (!session?.adapterScope)
            deny('adapter required');
        const scope = { provider: 'stripe', environment: a.environment, account: a.account };
        await ctx.db.patch(b._id, { ...scope, kind: 'merchant', externalId: a.account, local: b.org, healthy: a.healthy });
        await ctx.db.patch(session._id, { adapterScope: scope });
    } });
export const registerCustomer = mutation({ args: { token: v.string(), binding: v.id('bindings'), externalId: v.string(), name: v.string() }, handler: async (ctx, a) => { const b = await adapter(ctx, a.token, a.binding); const existing = await ctx.db.query('payCustomers').withIndex('external', q => q.eq('binding', a.binding).eq('externalId', a.externalId)).unique(); return existing ? existing._id : ctx.db.insert('payCustomers', { org: b.org, binding: a.binding, externalId: a.externalId, name: a.name, deleted: false }); } });
export const createQuote = mutation({ args: { token: v.string(), customer: v.id('payCustomers'), amountMinor: v.number(), currency }, handler: async (ctx, a) => { const who = await human(ctx, a.token), { row: c } = await own(ctx, a.token, await ctx.db.get(a.customer)); await writable(ctx, c.org, c.binding); if (c.deleted)
        deny('customer deleted'); money(a.amountMinor); if (!a.amountMinor)
        deny('positive quote required'); const id = await ctx.db.insert('quotes', { org: c.org, binding: c.binding, customer: c._id, customerName: c.name, version: 1, amountMinor: a.amountMinor, currency: a.currency, state: 'draft' }); await audit(ctx, c.org, who._id, 'quote.created', id); return id; } });
export const reviseQuote = mutation({ args: { token: v.string(), id: v.id('quotes'), amountMinor: v.number() }, handler: async (ctx, a) => { await human(ctx, a.token); const { row: q } = await own(ctx, a.token, await ctx.db.get(a.id)); await writable(ctx, q.org, q.binding); if (q.state !== 'draft')
        deny('accepted quote immutable'); if(!a.amountMinor)deny('positive quote required'); await ctx.db.patch(q._id, { amountMinor: money(a.amountMinor), version: q.version + 1, tokenHash: undefined, expires: undefined }); await audit(ctx,q.org,(await human(ctx,a.token))._id,'quote.revised',q._id); } });
export const issueAcceptance = action({ args: { token: v.string(), id: v.id('quotes'), expires: v.number() }, handler: async (ctx, a): Promise<{
        token: string;
        version: number;
    }> => { const token = crypto.randomUUID() + crypto.randomUUID(); const version = await ctx.runMutation(internal.payments.setAcceptance, { ...a, tokenHash: await hash(token) }); return { token, version }; } });
export const setAcceptance = internalMutation({ args: { token: v.string(), id: v.id('quotes'), expires: v.number(), tokenHash: v.string() }, handler: async (ctx, a) => { await human(ctx, a.token); const { row: q } = await own(ctx, a.token, await ctx.db.get(a.id)); await writable(ctx, q.org, q.binding); if (q.state !== 'draft' || a.expires <= Date.now() || a.expires > Date.now() + 86400000)
        deny('invalid acceptance expiry'); await ctx.db.patch(q._id, { tokenHash: a.tokenHash, expires: a.expires }); return q.version; } });
export const acceptQuote = mutation({ args: { id: v.id('quotes'), version: v.number(), token: v.string() }, handler: async (ctx, a) => { const q = await ctx.db.get(a.id); if (!q || q.tokenHash !== await hash(a.token) || q.version !== a.version || !q.expires || q.expires <= Date.now())
        deny('invalid or expired acceptance'); const minute = Math.floor(Date.now() / 60000), count = q.attemptMinute === minute ? (q.attemptCount ?? 0) : 0; if (count >= 20)
        deny('acceptance rate limited'); await ctx.db.patch(q._id, { attemptMinute: minute, attemptCount: count + 1 }); if (q.state === 'accepted')
        return q._id; await writable(ctx, q.org, q.binding); await ctx.db.patch(q._id, { state: 'accepted', acceptedAt: Date.now() }); await audit(ctx, q.org, 'public-acceptance', 'quote.accepted', q._id); return q._id; } });
async function document(ctx: MutationCtx, q: Doc<'quotes'>, kind: 'deposit' | 'balance', amountMinor: number, allocation?: Id<'documents'>) { const snapshot = { org: q.org, binding: q.binding, customer: q.customer, customerName: q.customerName, quote: q._id, quoteVersion: q.version, kind, amountMinor, currency: q.currency, ...(allocation ? { depositAllocation: allocation } : {}) }; return ctx.db.insert('documents', { ...snapshot, state: 'intent', paidMinor: 0, refundedMinor: 0, snapshotHash: await hash(JSON.stringify(snapshot)), retentionUntil: Date.now() + 365 * 86400000 }); }
export const prepareDeposit = mutation({ args: { token: v.string(), quote: v.id('quotes'), amountMinor: v.number(), currency }, handler: async (ctx, a) => { await human(ctx, a.token); const { row: q } = await own(ctx, a.token, await ctx.db.get(a.quote)); await writable(ctx, q.org, q.binding); money(a.amountMinor); if (q.state !== 'accepted' || a.currency !== q.currency || a.amountMinor <= 0 || a.amountMinor > q.amountMinor)
        deny('invalid deposit obligation'); if (q.deposit) {
        const d = await ctx.db.get(q.deposit);
        if (d?.amountMinor !== a.amountMinor)
            deny('deposit already exists');
        return q.deposit;
    } const id = await document(ctx, q, 'deposit', a.amountMinor); await ctx.db.patch(q._id, { deposit: id }); await audit(ctx,q.org,(await human(ctx,a.token))._id,'deposit.prepared',id); return id; } });
export const prepareBalance = mutation({ args: { token: v.string(), quote: v.id('quotes') }, handler: async (ctx, a) => { await human(ctx, a.token); const { row: q } = await own(ctx, a.token, await ctx.db.get(a.quote)); await writable(ctx, q.org, q.binding); if (q.balance)
        return q.balance; const d = q.deposit && await ctx.db.get(q.deposit); if (!d || d.state !== 'paid' || d.paidMinor !== d.amountMinor || d.refundedMinor || d.allocatedTo || d.currency !== q.currency)
        deny('paid unallocated deposit required'); const id = await document(ctx, q, 'balance', money(q.amountMinor - d.amountMinor), d._id); await ctx.db.patch(q._id, { balance: id }); await ctx.db.patch(d._id, { allocatedTo: id }); await audit(ctx,q.org,(await human(ctx,a.token))._id,'balance.allocated',id); return id; } });
export const getDocument = query({ args: { token: v.string(), id: v.id('documents') }, handler: async (ctx, a) => { await human(ctx, a.token); return (await own(ctx, a.token, await ctx.db.get(a.id))).row; } });
export const issuance = query({ args: { token: v.string(), id: v.id('documents') }, handler: async (ctx, a) => { const d = await ctx.db.get(a.id); if (!d)
        deny('document missing'); const b = await adapter(ctx, a.token, d.binding), c = await ctx.db.get(d.customer); if (!c || c.org !== d.org || c.binding !== d.binding)
        deny('customer account mismatch'); if (!b.healthy)
        deny('merchant restricted or disconnected'); return { document: d, account: b.account, customer: c.externalId }; } });
export const attachProvider = mutation({ args: { token: v.string(), id: v.id('documents'), externalId: v.string() }, handler: async (ctx, a) => { const d = await ctx.db.get(a.id); if (!d)
        deny('document missing'); await adapter(ctx, a.token, d.binding); if (d.externalId && d.externalId !== a.externalId)
        deny('provider identity immutable'); const collision = await ctx.db.query('documents').withIndex('external', q => q.eq('binding', d.binding).eq('externalId', a.externalId)).unique(); if (collision && collision._id !== d._id)
        deny('provider binding collision'); await ctx.db.patch(d._id, { externalId: a.externalId, state: d.state === 'intent' ? 'issued' : d.state }); if(!d.externalId)await audit(ctx,d.org,'trusted-stripe-adapter','invoice.bound',d._id); } });
const adjustmentKind = v.union(v.literal('refund'), v.literal('credit'), v.literal('payment'));
const adjustmentStatus = v.union(v.literal('pending'),v.literal('succeeded'),v.literal('failed'),v.literal('cancelled'));
const adjustmentReceipt = v.object({kind:adjustmentKind,receiptId:v.string(),sourceRef:v.string(),operationId:v.optional(v.string()),amountMinor:v.number(),status:adjustmentStatus});
type Adjustment = {kind:'refund'|'credit'|'payment';receiptId:string;sourceRef:string;operationId?:string;amountMinor:number;status:'pending'|'succeeded'|'failed'|'cancelled'};
async function putAdjustment(ctx: MutationCtx, d: Doc<'documents'>, r: Adjustment, authoritative=false) {
 money(r.amountMinor);if(!r.receiptId||!r.sourceRef||r.amountMinor<=0)deny('invalid adjustment receipt');
 const b=await ctx.db.get(d.binding);if(!b)deny('binding missing');
 const old=await ctx.db.query('adjustmentReceipts').withIndex('receipt',q=>q.eq('provider',b.provider).eq('environment',b.environment).eq('account',b.account).eq('kind',r.kind).eq('receiptId',r.receiptId)).unique();
 if(old){
  if(old.document!==d._id||old.amountMinor!==r.amountMinor||old.sourceRef!==r.sourceRef||old.operationId!==r.operationId)deny('adjustment receipt binding mismatch');
  // A delayed create acknowledgement cannot overwrite an authoritative refetch.
  if(r.kind==='payment'&&old.status==='succeeded'&&r.status!=='succeeded')deny('paid receipt cannot regress');
  if(authoritative&&r.status!==old.status)await ctx.db.patch(old._id,{status:r.status});
 }else await ctx.db.insert('adjustmentReceipts',{binding:d.binding,document:d._id,provider:b.provider,environment:b.environment,account:b.account,...r});
}
async function adjustmentTotal(ctx: Ctx, d: Doc<'documents'>, kind:'refund'|'credit', held=false) {
 const rows=await ctx.db.query('adjustmentReceipts').withIndex('document',q=>q.eq('document',d._id).eq('kind',kind)).take(501);if(rows.length>500)deny('adjustment receipt bound reached');
 return rows.filter(r=>r.status==='succeeded'||(held&&r.status==='pending')).reduce((n,r)=>n+r.amountMinor,0);
}
async function matchedAdjustment(ctx: Ctx,d:Doc<'documents'>,kind:'refund'|'credit',receiptId:string) {
 const b=await ctx.db.get(d.binding);if(!b)deny('binding missing');
 return ctx.db.query('adjustmentReceipts').withIndex('receipt',q=>q.eq('provider',b.provider).eq('environment',b.environment).eq('account',b.account).eq('kind',kind).eq('receiptId',receiptId)).unique();
}
// Begin closes capacity and advances a target generation. Only that generation can finish.
export const reconcileAdjustments = mutation({args:{token:v.string(),binding:v.id('bindings'),externalId:v.string(),complete:v.boolean(),epoch:v.optional(v.number()),refundedMinor:v.number(),creditedMinor:v.number(),receipts:v.array(adjustmentReceipt)},handler:async(ctx,a)=>{
 const b=await adapter(ctx,a.token,a.binding);
 const d=await ctx.db.query('documents').withIndex('external',q=>q.eq('binding',a.binding).eq('externalId',a.externalId)).unique();if(!d)deny('unbound provider document');
 if(!a.complete){const epoch=(d.adjustmentEpoch??0)+1;await ctx.db.patch(d._id,{adjustmentsComplete:false,adjustmentEpoch:epoch});await audit(ctx,d.org,'trusted-stripe-adapter','adjustments.started',d._id);return epoch;}
 if(a.epoch===undefined||a.epoch!==d.adjustmentEpoch)deny('stale adjustment generation');
 money(a.refundedMinor);money(a.creditedMinor);if(a.receipts.length>500)deny('adjustment receipt bound reached');
 const keys=new Set(a.receipts.map(r=>r.kind+':'+r.receiptId));if(keys.size!==a.receipts.length)deny('duplicate adjustment identity');
 const sum=(kind:'refund'|'credit'|'payment')=>a.receipts.filter(r=>r.kind===kind&&r.status==='succeeded').reduce((n,r)=>n+r.amountMinor,0);
 if(sum('payment')!==d.paidMinor)deny('incomplete payment totals');
 const payments=a.receipts.filter(r=>r.kind==='payment');
 if(new Set(payments.map(r=>r.sourceRef)).size!==payments.length)deny('shared payment allocation unsupported');
 const retained=await ctx.db.query('adjustmentReceipts').withIndex('document',q=>q.eq('document',d._id).eq('kind','payment')).take(501);
 if(retained.length>500||retained.some(r=>!payments.some(p=>p.receiptId===r.receiptId)))deny('missing retained payment receipt');
 for(const r of payments){
  if(r.status!=='succeeded')deny('unresolved provider payment');
  const other=await ctx.db.query('adjustmentReceipts').withIndex('receipt',q=>q.eq('provider',b.provider).eq('environment',b.environment).eq('account',b.account).eq('kind','payment').eq('receiptId',r.receiptId)).unique();
  if(other&&other.document!==d._id)deny('payment invoice mismatch');
  const allocation=await ctx.db.query('adjustmentReceipts').withIndex('source',q=>q.eq('provider',b.provider).eq('environment',b.environment).eq('account',b.account).eq('kind','payment').eq('sourceRef',r.sourceRef)).unique();
  if(allocation&&allocation.receiptId!==r.receiptId)deny('shared payment allocation unsupported');
  if(r.operationId){const held=await ctx.db.query('collections').withIndex('document',q=>q.eq('document',d._id)).take(501);if(held.length>500)deny('collection bound reached');
   let match=false;for(const h of held){const op=await ctx.db.get(h.operation);if(op&&await hash(op.logical)===r.operationId){if(h.amountMinor!==r.amountMinor||(h.providerRef&&h.providerRef!==r.sourceRef))deny('payment hold mismatch');match=true;}}
   if(!match)deny('payment command document mismatch');
  }
 }
 if(sum('refund')!==a.refundedMinor||sum('credit')!==a.creditedMinor||a.refundedMinor>d.paidMinor||a.creditedMinor>d.amountMinor)deny('incomplete adjustment totals');
 for(const r of a.receipts)await putAdjustment(ctx,d,r,true);
 await ctx.db.patch(d._id,{refundedMinor:await adjustmentTotal(ctx,d,'refund'),creditedMinor:await adjustmentTotal(ctx,d,'credit'),adjustmentsComplete:true});
 await audit(ctx,d.org,'trusted-stripe-adapter','adjustments.reconciled',d._id);return true;
}});
// Pull observations carry their epoch; independent aggregate callbacks invalidate unfinished pulls.
export const observe = mutation({ args: { token: v.string(), binding: v.id('bindings'), externalId: v.string(), eventId: v.string(), digest: v.string(), state: v.string(), paidMinor: v.number(), refundedMinor: v.number(), currency, amountMinor:v.optional(v.number()), reconciliationEpoch: v.optional(v.number()) }, handler: async (ctx, a) => { const b = await adapter(ctx, a.token, a.binding); const d = await ctx.db.query('documents').withIndex('external', q => q.eq('binding', a.binding).eq('externalId', a.externalId)).unique(); if (!d || d.org !== b.org)
        deny('unbound provider document'); if (a.reconciliationEpoch !== undefined && a.reconciliationEpoch !== d.adjustmentEpoch) deny('stale adjustment generation'); if (a.currency !== d.currency)
        deny('currency mismatch'); if(a.amountMinor!==undefined&&a.amountMinor!==d.amountMinor)deny('invoice total mismatch'); money(a.paidMinor); money(a.refundedMinor); if (a.refundedMinor > a.paidMinor)
        deny('refund exceeds paid'); const old = await ctx.db.query('payCallbacks').withIndex('event', q => q.eq('binding', a.binding).eq('eventId', a.eventId)).unique(); if (old) {
        if (old.digest !== a.digest)
            deny('event integrity mismatch');
        return false;
    } const normalized = await adjustmentTotal(ctx, d, 'refund'); await ctx.db.insert('payCallbacks', { binding: a.binding, eventId: a.eventId, digest: a.digest, document: d._id }); await ctx.db.patch(d._id, { state: a.state, paidMinor: a.paidMinor, refundedMinor: Math.max(a.refundedMinor, normalized), ...(a.refundedMinor !== normalized || a.paidMinor !== d.paidMinor || a.state !== d.state ? {adjustmentsComplete:false,...(a.reconciliationEpoch === undefined ? {adjustmentEpoch:(d.adjustmentEpoch??0)+1} : {})} : {}) }); await audit(ctx, d.org, 'trusted-stripe-adapter', 'payment.observed', d._id); return true; } });
export const removeCustomer = mutation({ args: { token: v.string(), id: v.id('payCustomers') }, handler: async (ctx, a) => { await human(ctx, a.token); const { row: c } = await own(ctx, a.token, await ctx.db.get(a.id)); await ctx.db.patch(c._id, { name: 'Deleted synthetic customer', deleted: true }); await audit(ctx,c.org,(await human(ctx,a.token))._id,'customer.redacted',c._id); } });
export const exportFinance = query({ args: { token: v.string() }, handler: async (ctx, a) => { const who = await human(ctx, a.token); return { quotes: (await ctx.db.query('quotes').collect()).filter(q => q.org === who.org).map(({ tokenHash, ...q }) => q), documents: (await ctx.db.query('documents').collect()).filter(d => d.org === who.org).map(({ paymentTokenHash, paymentUrl, ...d }) => d) }; } });
// Additive design proof; the frozen H0 general-write permit remains unchanged.
const safetyAction = v.union(v.literal('refund'), v.literal('cancel'));
async function financeMember(ctx: Ctx, a: Doc<'actors'>) {
    const member = await ctx.db.query('financeMembers').withIndex('actor', q => q.eq('actor', a._id)).unique();
    if (a.kind !== 'human' || a.state !== 'active' || !member || !['admin', 'finance'].includes(member.role))
        deny('current finance membership required');
}
async function safetyBinding(ctx: Ctx, d: Doc<'documents'>, binding: Id<'bindings'>, destination: string) {
    const b = await ctx.db.get(binding);
    if (d.binding !== binding || !b || b.org !== d.org || b.account !== destination)
        deny('safety account mismatch');
    if (!b.healthy)
        deny('merchant restricted or disconnected');
    return b;
}
export const bindSafetyReference = mutation({ args: { token: v.string(), id: v.id('documents'), paymentIntent: v.optional(v.string()), subscription: v.optional(v.string()), charge:v.optional(v.string()) }, handler: async (ctx, a) => {
        const d = await ctx.db.get(a.id);
        if (!d)
            deny('document missing');
        await adapter(ctx, a.token, d.binding);
        if ((a.paymentIntent && d.paymentIntent && d.paymentIntent !== a.paymentIntent) || (a.subscription && d.subscription && d.subscription !== a.subscription) || (a.charge && d.charge && d.charge !== a.charge))
            deny('provider identity immutable');
        const {token,id,...references}=a;await ctx.db.patch(d._id,references);
    } });
export const prepareSafety = mutation({ args: { token: v.string(), document: v.id('documents'), binding: v.id('bindings'), destination: v.string(), action: safetyAction, amountMinor: v.number(), logical: v.string() }, handler: async (ctx, a) => {
        const who = await human(ctx, a.token), { row: d } = await own(ctx, a.token, await ctx.db.get(a.document));
        await financeMember(ctx, who);
        await safetyBinding(ctx, d, a.binding, a.destination);
        money(a.amountMinor);
        if (a.action === 'refund' ? (a.amountMinor <= 0 || !d.paymentIntent || !d.charge) : (a.amountMinor !== 0 || !d.subscription))
            deny('invalid safety amount or provider reference');
        const old = await ctx.db.query('safetyOps').withIndex('logical', q => q.eq('org', who.org).eq('logical', a.logical)).unique();
        if (old) {
            if (old.actor !== who._id || old.document !== d._id || old.binding !== a.binding || old.action !== a.action || old.amountMinor !== a.amountMinor)
                deny('safety logical collision');
            return old._id;
        }
        const session = await ctx.db.query('sessions').withIndex('token', q => q.eq('token', a.token)).unique();
        if (!session)
            deny('session revoked');
        const id = await ctx.db.insert('safetyOps', { org: who.org, actor: who._id, actorEpoch: who.epoch, session: session._id, document: d._id, binding: a.binding, account: a.destination, action: a.action, amountMinor: a.amountMinor, logical: a.logical, expires: Date.now() + 60000, state: 'prepared', baselineRefunded: d.refundedMinor, late: false });
        await audit(ctx, who.org, who._id, 'safety.prepared.' + a.action, id);
        return id;
    } });
export const permitSafety = mutation({ args: { token: v.string(), id: v.id('safetyOps') }, handler: async (ctx, a) => {
        const op = await ctx.db.get(a.id);
        if (!op)
            deny('safety operation missing');
        await adapter(ctx, a.token, op.binding);
        if (op.state !== 'prepared')
            deny('safety already dispatched; lookup required');
        const who = await ctx.db.get(op.actor), session = await ctx.db.get(op.session), d = await ctx.db.get(op.document);
        if (!who || who.state !== 'active' || who.epoch !== op.actorEpoch || session?.actor !== who._id || op.expires <= Date.now())
            deny('safety authority revoked or expired');
        await financeMember(ctx, who);
        if (!d)
            deny('document missing');
        await safetyBinding(ctx, d, op.binding, op.account);
        const pending = await ctx.db.query('safetyOps').withIndex('document', q => q.eq('document', d._id).eq('state', 'sent')).collect();
        const reserved = pending.filter(p => p.action === 'refund' && !p.providerRef).reduce((n,p)=>n+p.amountMinor,0);
        if(op.action === 'refund' && !d.adjustmentsComplete)deny('adjustment reconciliation incomplete');
        if(op.action === 'refund' && ((d.disputeStatus !== undefined && !['won','warning_closed'].includes(d.disputeStatus)) || (d.disputeStatus === undefined && (d.disputeAmountMinor??0)>0)))deny('dispute prevents refund');
        if (op.action === 'refund' && op.amountMinor > d.paidMinor - await adjustmentTotal(ctx,d,'refund',true) - reserved)
            deny('refund exceeds remaining paid less reservations');
        if (op.action === 'cancel' && pending.some(p => p.action === 'cancel'))
            deny('cancellation already pending');
        await ctx.db.patch(op._id, { state: 'sent', baselineRefunded: d.refundedMinor });
        await audit(ctx, op.org, who._id, 'readonly.safety.permit.' + op.action, op._id);
        return { key: op._id + ':step:1', account: op.account, action: op.action, amountMinor: op.amountMinor, paymentIntent: d.paymentIntent, charge:d.charge, subscription: d.subscription, currency: d.currency };
    } });
export const settleSafety = mutation({ args: { token: v.string(), id: v.id('safetyOps'), providerRef: v.string(), receipt:v.optional(adjustmentReceipt) }, handler: async (ctx, a) => {
        const op = await ctx.db.get(a.id);
        if (!op)
            deny('safety operation missing');
        await adapter(ctx, a.token, op.binding);
        if (op.state === 'prepared')
            deny('unpermitted safety outcome');
        if (op.providerRef && op.providerRef !== a.providerRef)
            deny('safety provider result collision');
        if (op.state === 'settled')
            return { duplicate: true, late: op.late, status:op.providerStatus??'succeeded' };
        const who = await ctx.db.get(op.actor), session = await ctx.db.get(op.session), d = await ctx.db.get(op.document);
        let late = false, status='succeeded';
        try {
            if (!who || who.epoch !== op.actorEpoch || session?.actor !== who._id)
                deny('revoked');
            await financeMember(ctx, who);
        }
        catch {
            late = true;
        }
        if (!d) deny('document missing');
        const receipt = await ctx.db.query('safetyOps').withIndex('receipt', q => q.eq('binding', op.binding).eq('providerRef', a.providerRef)).unique();
        if (receipt && receipt._id !== op._id) deny('safety receipt already bound');
        if (op.action === 'refund') {
            if(a.receipt){if(a.receipt.kind!=='refund'||a.receipt.receiptId!==a.providerRef||a.receipt.sourceRef!==d.charge||a.receipt.operationId!==op._id||a.receipt.amountMinor!==op.amountMinor)deny('safety receipt operation mismatch');await putAdjustment(ctx,d,a.receipt);}
            const verified=await matchedAdjustment(ctx,d,'refund',a.providerRef);
            if(!verified||verified.document!==d._id||verified.sourceRef!==d.charge||verified.operationId!==op._id||verified.amountMinor!==op.amountMinor)deny('safety receipt operation mismatch');
            status=verified.status??'pending';
            if(verified.status==='pending'){await ctx.db.patch(op._id,{providerRef:a.providerRef,providerStatus:'pending',late});await audit(ctx,op.org,'trusted-stripe-adapter','safety.pending',op._id);return{duplicate:false,late,status:'pending'};}
            await ctx.db.patch(d._id,{refundedMinor:await adjustmentTotal(ctx,d,'refund')});
        }
        await ctx.db.patch(op._id, { state: 'settled', providerRef: a.providerRef, providerStatus:status, late });
        await audit(ctx, op.org, 'trusted-stripe-adapter', late ? 'safety.late.'+status : 'safety.settled.'+status, op._id);
        return { duplicate: false, late, status };
    } });
// Only normalized event identity is persisted; full Stripe payloads can contain client secrets.
export const ingest = mutation({ args: { token: v.string(), binding: v.id('bindings'), eventId: v.string(), type: v.string(), externalId: v.string(), digest: v.string() }, handler: async (ctx, a) => {
        await adapter(ctx, a.token, a.binding);
        const old = await ctx.db.query('payIncoming').withIndex('event', q => q.eq('binding', a.binding).eq('eventId', a.eventId)).unique();
        if (old) {
            if (old.digest !== a.digest)
                deny('event integrity mismatch');
            return false;
        }
        const { token, ...row } = a;
        await ctx.db.insert('payIncoming', { ...row, done: false });
        return true;
    } });
export const pendingEvents = query({ args: { token: v.string(), binding: v.id('bindings') }, handler: async (ctx, a) => { await adapter(ctx, a.token, a.binding); return ctx.db.query('payIncoming').withIndex('pending', q => q.eq('binding', a.binding).eq('done', false)).take(100); } });
export const ackEvent = mutation({ args: { token: v.string(), id: v.id('payIncoming') }, handler: async (ctx, a) => { const e = await ctx.db.get(a.id); if (!e)
        deny('event missing'); await adapter(ctx, a.token, e.binding); await ctx.db.patch(e._id, { done: true }); } });
export const prepareInvoice = mutation({ args: { token: v.string(), customer: v.id('payCustomers'), amountMinor: v.number(), currency, kind: v.union(v.literal('invoice'), v.literal('recurring')) }, handler: async (ctx, a) => {
        const who = await human(ctx, a.token), { row: c } = await own(ctx, a.token, await ctx.db.get(a.customer));
        await writable(ctx, c.org, c.binding);
        money(a.amountMinor);
        if (!a.amountMinor || c.deleted)
            deny('invalid invoice');
        const snapshot = { org: who.org, binding: c.binding, customer: c._id, customerName: c.name, kind: a.kind, amountMinor: a.amountMinor, currency: a.currency };
        const id = await ctx.db.insert('documents', { ...snapshot, state: 'intent', paidMinor: 0, refundedMinor: 0, snapshotHash: await hash(JSON.stringify(snapshot)), retentionUntil: Date.now() + 365 * 86400000 });
        await audit(ctx, who.org, who._id, 'invoice.prepared', id);
        return id;
    } });
export const bindPaymentPage = mutation({ args: { token: v.string(), id: v.id('documents'), url: v.string() }, handler: async (ctx, a) => {
        const d = await ctx.db.get(a.id);
        if (!d)
            deny('document missing');
        await adapter(ctx, a.token, d.binding);
        const u = new URL(a.url);
        if (u.origin !== 'https://invoice.stripe.com' || u.username || u.password)
            deny('secure payment origin refused');
        if (d.paymentUrl && d.paymentUrl !== a.url)
            deny('payment page immutable');
        await ctx.db.patch(d._id, { paymentUrl: a.url });
    } });
export const issuePaymentLink = action({ args: { token: v.string(), id: v.id('documents'), expires: v.number() }, handler: async (ctx, a): Promise<{
        token: string;
    }> => {
        const token = crypto.randomUUID() + crypto.randomUUID();
        await ctx.runMutation(internal.payments.setPaymentLink, { ...a, tokenHash: await hash(token) });
        return { token };
    } });
export const setPaymentLink = internalMutation({ args: { token: v.string(), id: v.id('documents'), expires: v.number(), tokenHash: v.string() }, handler: async (ctx, a) => {
        await human(ctx, a.token);
        const { row: d } = await own(ctx, a.token, await ctx.db.get(a.id));
        await writable(ctx, d.org, d.binding);
        if (!d.paymentUrl || !d.externalId || a.expires <= Date.now() || a.expires > Date.now() + 86400000)
            deny('invalid payment capability');
        await ctx.db.patch(d._id, { paymentTokenHash: a.tokenHash, paymentTokenExpires: a.expires });
    } });
export const publicPayment = query({ args: { token: v.string() }, handler: async (ctx, a) => {
        const digest = await hash(a.token), d = await ctx.db.query('documents').withIndex('paymentToken', q => q.eq('paymentTokenHash', digest)).unique();
        if (!d || !d.paymentUrl || !d.paymentTokenExpires || d.paymentTokenExpires <= Date.now())
            deny('invalid or expired payment capability');
        await writable(ctx, d.org, d.binding);
        return { amountMinor: d.amountMinor, currency: d.currency, url: d.paymentUrl };
    } });
export const observeRenewal = mutation({ args: { token: v.string(), parent: v.id('documents'), subscription: v.string(), invoice: v.string(), amountMinor: v.number(), currency, paidMinor: v.number(), state: v.string(), eventId: v.string(), digest: v.string() }, handler: async (ctx, a) => {
        const p = await ctx.db.get(a.parent);
        if (!p)
            deny('recurring document missing');
        await adapter(ctx, a.token, p.binding);
        if (p.kind !== 'recurring' || p.subscription !== a.subscription || p.amountMinor !== a.amountMinor || p.currency !== a.currency)
            deny('recurring binding or obligation mismatch');
        money(a.paidMinor);
        const oldEvent = await ctx.db.query('payCallbacks').withIndex('event', q => q.eq('binding', p.binding).eq('eventId', a.eventId)).unique();
        if (oldEvent) {
            if (oldEvent.digest !== a.digest)
                deny('event integrity mismatch');
            return oldEvent.document;
        }
        let d = await ctx.db.query('documents').withIndex('external', q => q.eq('binding', p.binding).eq('externalId', a.invoice)).unique();
        if (!d) {
            const snapshot = { org: p.org, binding: p.binding, customer: p.customer, customerName: p.customerName, kind: 'recurring' as const, amountMinor: a.amountMinor, currency: a.currency, subscription: a.subscription };
            const id = await ctx.db.insert('documents', { ...snapshot, state: a.state, externalId: a.invoice, paidMinor: a.paidMinor, refundedMinor: 0, adjustmentsComplete:false, adjustmentEpoch:1, snapshotHash: await hash(JSON.stringify(snapshot)), retentionUntil: p.retentionUntil });
            d = await ctx.db.get(id);
        }
        if (!d || d.org !== p.org || d.customer !== p.customer)
            deny('recurring document mismatch');
        await ctx.db.patch(d._id, { paidMinor: a.paidMinor, state: a.state, ...(a.paidMinor !== d.paidMinor || a.state !== d.state ? {adjustmentsComplete:false,adjustmentEpoch:(d.adjustmentEpoch??0)+1} : {}) });
        await ctx.db.insert('payCallbacks', { binding: p.binding, eventId: a.eventId, digest: a.digest, document: d._id });
        await audit(ctx, p.org, 'trusted-stripe-adapter', 'renewal.observed', d._id);
        return d._id;
    } });
export const observeService = mutation({ args: { token: v.string(), id: v.id('documents'), subscription: v.string(), status: v.union(v.literal('active'), v.literal('past_due'), v.literal('canceled'), v.literal('unpaid'), v.literal('incomplete'), v.literal('trialing'), v.literal('incomplete_expired'), v.literal('paused')) }, handler: async (ctx, a) => {
        const d = await ctx.db.get(a.id);
        if (!d)
            deny('document missing');
        await adapter(ctx, a.token, d.binding);
        if (d.subscription !== a.subscription)
            deny('subscription binding mismatch');
        await ctx.db.patch(d._id, { subscriptionStatus: a.status });
        await audit(ctx, d.org, 'trusted-stripe-adapter', 'service.observed', d._id);
    } });
export const observeAdjustment = mutation({ args: { token: v.string(), id: v.id('documents'), creditedMinor: v.optional(v.number()), disputeAmountMinor: v.optional(v.number()), disputeStatus: v.optional(v.string()) }, handler: async (ctx, a) => {
        const d = await ctx.db.get(a.id);
        if (!d)
            deny('document missing');
        await adapter(ctx, a.token, d.binding);
        if (a.creditedMinor !== undefined)
            money(a.creditedMinor);
        if (a.disputeAmountMinor !== undefined)
            money(a.disputeAmountMinor);
        const { token, id, ...changes } = a;
        if (changes.creditedMinor !== undefined) {
            const normalized=await adjustmentTotal(ctx,d,'credit');
            await ctx.db.patch(d._id,{adjustmentsComplete:changes.creditedMinor===normalized&&d.adjustmentsComplete===true,...(changes.creditedMinor!==normalized ? {adjustmentEpoch:(d.adjustmentEpoch??0)+1} : {})});
            changes.creditedMinor=Math.max(changes.creditedMinor,normalized);
        }
        await ctx.db.patch(d._id, changes);
        await audit(ctx, d.org, 'trusted-stripe-adapter', 'adjustment.observed', d._id);
    } });
async function unmatchedCollections(ctx: Ctx,d:Doc<'documents'>) {
 const held=await ctx.db.query('collections').withIndex('document',q=>q.eq('document',d._id)).take(501),paid=await ctx.db.query('adjustmentReceipts').withIndex('document',q=>q.eq('document',d._id).eq('kind','payment')).take(501);
 if(held.length>500||paid.length>500)deny('collection bound reached');
 let total=0;for(const h of held){const op=await ctx.db.get(h.operation);const command=op&&await hash(op.logical);
  if(!h.providerRef||!paid.some(r=>r.status==='succeeded'&&r.sourceRef===h.providerRef&&r.operationId===command&&r.amountMinor===h.amountMinor))total+=h.amountMinor;
 }return total;
}
async function committedCredits(ctx: Ctx,d:Doc<'documents'>) {
 const pending=await ctx.db.query('lifecycleOps').withIndex('document',q=>q.eq('document',d._id).eq('state','sent')).take(501);
 if(pending.length>500)deny('lifecycle bound reached');
 const receipts=await ctx.db.query('adjustmentReceipts').withIndex('document',q=>q.eq('document',d._id).eq('kind','credit')).take(501);if(receipts.length>500)deny('adjustment receipt bound reached');
 return await adjustmentTotal(ctx,d,'credit')+pending.filter(p=>p.action==='credit'&&!receipts.some(r=>r.operationId===p._id&&r.sourceRef===d.externalId&&r.amountMinor===p.amountMinor&&r.status!=='pending')).reduce((n,p)=>n+p.amountMinor,0);
}
// Proposed C1 mapping, pending D0P/I1/I7 review. No agent capability or readonly bypass.
export const prepareLifecycle=mutation({args:{token:v.string(),document:v.id('documents'),action:v.union(v.literal('credit'),v.literal('void')),amountMinor:v.number()},handler:async(ctx,a)=>{
 const who=await human(ctx,a.token),{row:d}=await own(ctx,a.token,await ctx.db.get(a.document));await financeMember(ctx,who);await writable(ctx,d.org,d.binding);money(a.amountMinor);
 if(!d.externalId||(a.action==='void'?a.amountMinor!==0:a.amountMinor<=0))deny('invalid lifecycle command');
 const b=await ctx.db.get(d.binding),s=await ctx.db.query('sessions').withIndex('token',q=>q.eq('token',a.token)).unique();if(!b||!s)deny('authority missing');
 return ctx.db.insert('lifecycleOps',{org:d.org,actor:who._id,actorEpoch:who.epoch,session:s._id,document:d._id,binding:d.binding,account:b.account,action:a.action,amountMinor:a.amountMinor,state:'prepared',expires:Date.now()+60000});
}});
export const permitLifecycle=mutation({args:{token:v.string(),id:v.id('lifecycleOps')},handler:async(ctx,a)=>{
 const op=await ctx.db.get(a.id);if(!op)deny('lifecycle command missing');await adapter(ctx,a.token,op.binding);if(op.state!=='prepared')deny('lifecycle already dispatched; lookup required');
 const who=await ctx.db.get(op.actor),session=await ctx.db.get(op.session),d=await ctx.db.get(op.document);
 if(!who||who.epoch!==op.actorEpoch||session?.actor!==who._id||op.expires<=Date.now())deny('lifecycle authority revoked');await financeMember(ctx,who);
 if(!d||!d.externalId)deny('document missing');await writable(ctx,op.org,op.binding);await safetyBinding(ctx,d,op.binding,op.account);
 const pending=await ctx.db.query('lifecycleOps').withIndex('document',q=>q.eq('document',d._id).eq('state','sent')).collect();
 if(pending.some(p=>p.action==='void'))deny('void already pending');
 if(op.action==='credit'&&!d.adjustmentsComplete)deny('adjustment reconciliation incomplete');
 if(op.action==='void'&&d.adjustmentsComplete!==true)deny('payment reconciliation incomplete');
 if(await unmatchedCollections(ctx,d))deny('unmatched collection prevents lifecycle change');
 const committed=await committedCredits(ctx,d);
 if(op.action==='void'?(d.paidMinor!==0||pending.length!==0):op.amountMinor>d.amountMinor-committed)deny('lifecycle exceeds remaining obligation');
 await ctx.db.patch(op._id,{state:'sent'});await audit(ctx,op.org,who._id,'lifecycle.permit.'+op.action,op._id);
 return{key:op._id+':step:1',account:op.account,invoice:d.externalId,action:op.action,amountMinor:op.amountMinor};
}});
export const settleLifecycle=mutation({args:{token:v.string(),id:v.id('lifecycleOps'),providerRef:v.string(),receipt:v.optional(adjustmentReceipt)},handler:async(ctx,a)=>{
 const op=await ctx.db.get(a.id);if(!op)deny('lifecycle command missing');await adapter(ctx,a.token,op.binding);if(op.state==='prepared')deny('unpermitted lifecycle outcome');
 if(op.providerRef&&op.providerRef!==a.providerRef)deny('lifecycle receipt collision');if(op.state==='settled')return false;
 const d=await ctx.db.get(op.document);if(!d)deny('document missing');
 const receipt=await ctx.db.query('lifecycleOps').withIndex('receipt',q=>q.eq('binding',op.binding).eq('providerRef',a.providerRef)).unique();
 if(receipt&&receipt._id!==op._id)deny('lifecycle receipt already bound');
 if(op.action==='credit'){if(a.receipt){if(a.receipt.kind!=='credit'||a.receipt.receiptId!==a.providerRef||a.receipt.sourceRef!==d.externalId||a.receipt.operationId!==op._id||a.receipt.amountMinor!==op.amountMinor)deny('lifecycle receipt operation mismatch');await putAdjustment(ctx,d,a.receipt);}
 const verified=await matchedAdjustment(ctx,d,'credit',a.providerRef);if(!verified||verified.document!==d._id||verified.sourceRef!==d.externalId||verified.operationId!==op._id||verified.amountMinor!==op.amountMinor||verified.status==='pending')deny('lifecycle receipt operation mismatch');await ctx.db.patch(d._id,{creditedMinor:await adjustmentTotal(ctx,d,'credit')});}else await ctx.db.patch(d._id,{state:'void'});
 await ctx.db.patch(op._id,{state:'settled',providerRef:a.providerRef});await audit(ctx,op.org,'trusted-stripe-adapter','lifecycle.observed.'+op.action,op._id);return true;
}});
export const reserveCollection=mutation({args:{token:v.string(),document:v.id('documents'),operation:v.id('operations'),amountMinor:v.number()},handler:async(ctx,a)=>{
 const d=await ctx.db.get(a.document);if(!d)deny('document missing');const b=await adapter(ctx,a.token,d.binding),op=await ctx.db.get(a.operation);money(a.amountMinor);
 if(!op||op.org!==d.org||op.binding!==d.binding||op.capability!=='billing.collect'||!op.logical.startsWith(d._id+':')||op.payload.amountMinor!==a.amountMinor||op.payload.currency!==d.currency||op.payload.destination!==b.account||a.amountMinor<=0)deny('collection payload mismatch');
 const existing=await ctx.db.query('collections').withIndex('operation',q=>q.eq('operation',op._id)).unique();if(existing)return existing._id;
 if((d.externalId&&d.adjustmentsComplete!==true)||d.adjustmentsComplete===false)deny('payment reconciliation incomplete');
 if(!['intent','issued','open'].includes(d.state)||(await ctx.db.query('lifecycleOps').withIndex('document',q=>q.eq('document',d._id)).collect()).some(p=>p.action==='void'&&p.state!=='prepared'))deny('void prevents collection');
 if(!op.permitUsed||op.permitUntil<=Date.now()||!(op.consumedPermits??[]).length)deny('consumed current H0 permit required');
 const held=await unmatchedCollections(ctx,d),credits=await committedCredits(ctx,d);
 if(a.amountMinor>d.amountMinor-d.paidMinor-held-credits)deny('collection exceeds remaining obligation');
 const id=await ctx.db.insert('collections',{org:d.org,binding:d.binding,document:d._id,operation:op._id,amountMinor:a.amountMinor});await audit(ctx,d.org,op.actor,'collection.reserved',id);return id;
}});
export const recordCollection=mutation({args:{token:v.string(),id:v.id('collections'),providerRef:v.string()},handler:async(ctx,a)=>{
 const row=await ctx.db.get(a.id);if(!row)deny('collection missing');await adapter(ctx,a.token,row.binding);
 if(!/^pi_[A-Za-z0-9_]+$/.test(a.providerRef))deny('payment intent identity required');
 const collision=await ctx.db.query('collections').withIndex('receipt',q=>q.eq('binding',row.binding).eq('providerRef',a.providerRef)).unique();if(collision&&collision._id!==row._id)deny('collection receipt already bound');
 if(row.providerRef){if(row.providerRef!==a.providerRef)deny('collection receipt collision');return false;}
 await ctx.db.patch(row._id,{providerRef:a.providerRef});await audit(ctx,row.org,'trusted-stripe-adapter','collection.observed',row._id);return true;
}});
