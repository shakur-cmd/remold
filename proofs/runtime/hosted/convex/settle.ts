// P6-owned, outside the frozen H0 files. Checks status, reconciles usage and applies the output in one
// transaction, so a cancel, org kill or revocation commits entirely before or entirely after it.
import { mutation } from './_generated/server';
import { v } from 'convex/values';
import { api } from './_generated/api';

type Settled = { accepted: boolean; late?: boolean; overrun?: boolean; usage?: number; cancelled: boolean; underreport: boolean; applied: boolean };

export const settle = mutation({
    args: { token: v.string(), id: v.id('operations'), fence: v.number(), step: v.number(), providerRef: v.string(), meter: v.number(), reported: v.optional(v.number()), killed: v.boolean(), output: v.optional(v.string()) },
    handler: async (ctx, a): Promise<Settled> => {
        let cancelled = true;
        try {
            cancelled = (await ctx.runQuery(api.harness.adapterStatus, { token: a.token, id: a.id, fence: a.fence, step: a.step })).cancel;
        }
        catch { }
        // The guest's report can raise the bill above the executor's meter, never lower it.
        // A missing report stays missing so H0 holds the tenant.
        const underreport = a.reported !== undefined && a.reported < a.meter;
        const usage = a.killed ? a.meter : a.reported === undefined ? undefined : Math.max(a.meter, a.reported);
        const r = await ctx.runMutation(api.harness.reconcile, { token: a.token, id: a.id, fence: a.fence, step: a.step, providerRef: a.providerRef, usage });
        // A duplicate or collision report carries no late/overrun; a replay is refused because its status is already terminal.
        const fresh = 'overrun' in r && r.overrun !== undefined, late = fresh ? r.late : undefined, overrun = fresh ? r.overrun : undefined;
        const op = await ctx.db.get(a.id);
        if (!op)
            throw new Error('unknown operation');
        if (underreport) {
            await ctx.db.patch(op._id, { anomaly: 'usageUnderreport' });
            await ctx.db.patch(op.org, { anomaly: 'usageUnderreport' });
            await ctx.db.insert('events', { org: op.org, actor: 'trusted-adapter', kind: 'anomaly:usageUnderreport', resource: op._id, at: Date.now() });
        }
        const applied = !a.killed && !cancelled && usage !== undefined && !underreport && r.accepted && !overrun && a.output !== undefined;
        if (applied)
            await ctx.db.insert('records', { org: op.org, object: 'modelOutput', public: a.output!, secret: '' });
        return { accepted: r.accepted, late, overrun, usage, cancelled, underreport, applied };
    },
});
