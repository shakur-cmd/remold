import type { Id } from './_generated/dataModel';
import { v, type Infer } from 'convex/values';
export const capability = v.union(v.literal('read'), v.literal('marketing.send'), v.literal('model.call'), v.literal('agent.manage'), v.literal('billing.collect'), v.literal('billing.refund'));
export const scope = v.union(v.object({ kind: v.literal('records'), object: v.string(), records: v.union(v.literal('all'), v.array(v.id('records'))), fields: v.array(v.string()) }), v.object({ kind: v.literal('bindings'), bindings: v.array(v.id('bindings')), maxAmountMinor: v.number(), currency: v.string(), maxRecipients: v.number() }), v.object({ kind: v.literal('model'), maxUnitsPerRun: v.number(), maxSteps: v.number() }), v.object({ kind: v.literal('agents'), agents: v.array(v.id('actors')) }));
export const adapterScope = v.object({ provider: v.string(), environment: v.string(), account: v.string() });
export const payload = v.object({ content: v.string(), audience: v.array(v.string()), audienceVersion: v.number(), destination: v.string(), schedule: v.number(), amountMinor: v.number(), currency: v.string(), workflowVersion: v.number() });
export const outcome = v.union(v.object({ kind: v.literal('accepted'), ref: v.string(), usage: v.optional(v.number()) }), v.object({ kind: v.literal('rejected'), retryable: v.boolean() }), v.object({ kind: v.literal('unknown') }), v.object({ kind: v.literal('lookup'), found: v.boolean(), ref: v.optional(v.string()) }));
export type Scope = Infer<typeof scope>;
export type Payload = Infer<typeof payload>;
export type Caller = {
    kind: 'member';
    actor: Id<'actors'>;
} | {
    kind: 'adapter';
    scope: Infer<typeof adapterScope>;
};
export type Outcome = Infer<typeof outcome>;
// Delegation target must be inside the grantor's explicit manage scope.
export function within(child: Scope, parent: Scope): boolean {
    if (child.kind !== parent.kind)
        return false;
    if (child.kind === 'records' && parent.kind === 'records')
        return child.object === parent.object && child.fields.every(x => parent.fields.includes(x)) && (parent.records === 'all' || (child.records !== 'all' && child.records.every(x => parent.records.includes(x))));
    if (child.kind === 'bindings' && parent.kind === 'bindings')
        return child.currency === parent.currency && child.maxAmountMinor <= parent.maxAmountMinor && child.maxRecipients <= parent.maxRecipients && child.bindings.every(x => parent.bindings.includes(x));
    if (child.kind === 'model' && parent.kind === 'model')
        return child.maxUnitsPerRun <= parent.maxUnitsPerRun && child.maxSteps <= parent.maxSteps;
    return child.kind === 'agents' && parent.kind === 'agents' && child.agents.every(x => parent.agents.includes(x));
}
export function project(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
    return Object.fromEntries(Object.entries(source).filter(([key]) => fields.includes(key)));
}
