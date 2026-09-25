import { v, type Infer } from 'convex/values';

export const recordScope = v.object({ objectId: v.id('objects'), records: v.union(v.literal('all'), v.array(v.id('records'))), fields: v.union(v.literal('all'), v.array(v.id('fields'))) });
export const actor = v.object({ kind: v.union(v.literal('user'), v.literal('agent')), id: v.string() });
export const capability = v.union(...(['read', 'propose', 'record.create', 'record.update', 'record.delete', 'marketing.send', 'social.publish', 'model.call', 'billing.issue', 'billing.collect', 'billing.refund', 'billing.cancelRecurring', 'agent.manage'] as const).map(v.literal));
export type RecordScope = Infer<typeof recordScope>;
export type Actor = Infer<typeof actor>;
export const capabilityScope = v.union(
  v.object({ kind: v.literal('records'), objectId: v.id('objects'), records: v.union(v.literal('all'), v.array(v.id('records'))), fields: v.array(v.id('fields')) }),
  v.object({ kind: v.literal('bindings'), bindings: v.array(v.id('integrationBindings')), maxAmountMinor: v.number(), currency: v.string(), maxRecipients: v.number() }),
  v.object({ kind: v.literal('model'), maxUnitsPerRun: v.number(), maxSteps: v.number() }),
  v.object({ kind: v.literal('agents'), agents: v.array(v.id('agents')) }),
);
export type CapabilityScope = Infer<typeof capabilityScope>;
export type Capability = Infer<typeof capability>;
export function within(child: CapabilityScope, parent: CapabilityScope): boolean {
  if (child.kind === 'records' && parent.kind === 'records') return child.objectId === parent.objectId && child.fields.every(id => parent.fields.includes(id)) && (parent.records === 'all' || (child.records !== 'all' && child.records.every(id => parent.records.includes(id))));
  if (child.kind === 'bindings' && parent.kind === 'bindings') return child.bindings.every(id => parent.bindings.includes(id)) && child.currency === parent.currency && child.maxAmountMinor <= parent.maxAmountMinor && child.maxRecipients <= parent.maxRecipients;
  if (child.kind === 'model' && parent.kind === 'model') return child.maxUnitsPerRun <= parent.maxUnitsPerRun && child.maxSteps <= parent.maxSteps;
  return child.kind === 'agents' && parent.kind === 'agents' && child.agents.every(id => parent.agents.includes(id));
}
