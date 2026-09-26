import { internalQuery } from './_generated/server';
import { v } from 'convex/values';

// Scratch-only fixture used to compare every org-scoped table before and after
// a rejected request. It intentionally leaves Convex metadata out of the dump.
const clean = (row: any) => {
  const { _creationTime, ...value } = row;
  return value;
};
export const everything = internalQuery({ args: { orgId: v.id('orgs') }, handler: async (ctx, { orgId }) => {
  const tables = ['agents', 'objects', 'fields', 'records', 'events', 'suggestions', 'agentInbox', 'members', 'capabilityGrants', 'authorityAudit', 'integrationConnections', 'integrationIntents', 'integrationBindings', 'integrationOps', 'integrationEvents', 'consent', 'safetyTargets', 'integrationReceipts'];
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await ctx.db.query(table as any).collect()).filter((row: any) => row.orgId === orgId).map(clean)])));
} });
