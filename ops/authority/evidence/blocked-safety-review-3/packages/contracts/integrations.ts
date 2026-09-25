import { v } from 'convex/values';
export const externalCapability = v.union(v.literal('marketing.send'), v.literal('social.publish'), v.literal('model.call'), v.literal('billing.issue'), v.literal('billing.collect'), v.literal('billing.refund'), v.literal('billing.cancelRecurring'));
export const payload = v.object({ content: v.string(), audience: v.array(v.string()), audienceVersion: v.number(), destination: v.string(), schedule: v.number(), amountMinor: v.number(), currency: v.string(), workflowVersion: v.number() });
export const state = v.union(...(['proposed', 'approved', 'queued', 'dispatching', 'confirmed', 'refused', 'paused', 'cancellationPending', 'cancelled', 'outcomeUnknown'] as const).map(v.literal));

export const finalityRule = v.object({ capability: externalCapability, semantics: v.string(), proofRef: v.string() });
export const financialReceipt = v.object({ receiptId: v.string(), sourceRef: v.string(), currency: v.string(), amountMinor: v.number(), operationId: v.optional(v.string()), status: v.union(v.literal('pending'), v.literal('succeeded'), v.literal('failed'), v.literal('cancelled')) });
