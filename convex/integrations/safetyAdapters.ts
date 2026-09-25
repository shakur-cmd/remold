import type { ActionCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
export type SafetyCapability = 'billing.refund' | 'billing.cancelRecurring';
export type SafetyRequest = { operationId: Id<'integrationOps'>; key: string; capability: SafetyCapability; account: string; environment: string; providerRef: string; amountMinor: number; currency: string; secretHandle: string };
export type SafetyReceipt = { receiptId: string; sourceRef: string; currency: string; amountMinor: number; operationId?: string; status: 'pending' | 'succeeded' | 'failed' | 'cancelled' };
export type SafetyLookup = { lookupId: Id<'integrationLookups'>; generation: number; traversal: string; pageCount: number; digest: string; startedAt: number; completedAt: number };
export type SafetyAdapter = { proofRef: string; finality?: { proofRef: string; verifyAbsent: (ctx: ActionCtx, request: SafetyRequest, lookup: SafetyLookup) => Promise<boolean> }; dispatch: (ctx: ActionCtx, request: SafetyRequest) => Promise<SafetyReceipt> };
// Selected provider implementations belong here after their independent D0/I7 proof.
// There is no production fake adapter or caller-supplied function/URL fallback.
const adapters: Partial<Record<string, Partial<Record<SafetyCapability, SafetyAdapter>>>> = {};
export function safetyAdapter(provider: string, capability: SafetyCapability) { return adapters[provider]?.[capability]; }
