import subprocess, sys, json, os, re
ROOT=__import__('os').getcwd()  # run from the repository root
os.chdir(ROOT)
D='`'
M=[
 ('p-list-listed-path-off','convex/lib/list.ts','const listed = principal ? await listedRecords(ctx, principal, object) : null;','const listed = null as Doc<"records">[] | null;','auth'),
 ('p-related-member-listed-off','convex/records.ts','const listed = await listedRelated(ctx, principal, sourceObject, field, target._id);','const listed = null as any;','auth'),
 ('p-events-merge-off','convex/events.ts','const page = restricted ? await mergedEvents(','const page = false ? await mergedEvents(','auth'),
 ('p-csv-listed-off','convex/csv.ts','const listed = await listedRecords(ctx, principal, object);','const listed = null as any;','auth'),
 ('t-agent-related-take-then-filter','convex/agentApi.ts','let rows = (await listedRelated(ctx, principal, item.object, field, target._id))?.slice(0, 100);','let rows = undefined as Doc<"records">[] | undefined;','auth'),
 ('t-related-links-branch-off','convex/lib/list.ts','  if (field.type === "links") {\n    const hits','  if (field.type === "links") { return null;\n    const hits','auth'),
 ('t-related-lookup-branch-off','convex/lib/list.ts','  const name = slotName(field.slot!.kind, field.slot!.index);\n  return listed.filter','  return null; const name = slotName(field.slot!.kind, field.slot!.index);\n  return listed.filter','auth'),
 ('t-member-search-take-then-filter','convex/records.ts','const records = await searchRecords(ctx, principal, text, args.objectId, limit);','const records = await (text ? ctx.db.query("records").withSearchIndex("search_title", (q: any) => { const base = q.search("title", text).eq("orgId", args.orgId); return args.objectId ? base.eq("objectId", args.objectId) : base; }) : (ctx.db.query("records") as any).withIndex("by_object_updated", (q: any) => q.eq("orgId", args.orgId).eq("objectId", args.objectId!)).order("desc")).take(limit);','auth'),
 ('t-agent-search-take-then-filter','convex/agentApi.ts','const records = await searchRecords(ctx, principal, args.q.trim(), item?.object._id, limit);','const q = args.q.trim(), raw = await (q ? ctx.db.query("records").withSearchIndex("search_title", (query: any) => { const base = query.search("title", q).eq("orgId", principal.org._id); return item ? base.eq("objectId", item.object._id) : base; }) : (ctx.db.query("records") as any).withIndex("by_object_updated", (query: any) => query.eq("orgId", principal.org._id).eq("objectId", item!.object._id)).order("desc")).take(limit), records: Doc<"records">[] = []; for (const r of raw) { const o = await ctx.db.get(r.objectId); if (o && canReadRecord(principal, o, r)) records.push(r); }','auth'),
 ('t-find-take-then-filter','convex/lib/find.ts','  const listed = await listedRecords(ctx, principal, object);\n','  const listed = null as any;\n','auth'),
 ('t-member-today-tasks-take-then-filter','convex/today.ts','const tasks = task && !due?.retired ? await dueTasks(ctx, principal, task.object, due, done, args.today + 8 * DAY, 50) : [];','const tasks = task && due?.slot && !due.retired ? ((await (ctx.db.query("records") as any).withIndex('+D+'by_${due.slot.kind}${due.slot.index}'+D+', (q: any) => q.eq("orgId", args.orgId).eq("objectId", task.object._id).gt('+D+'${due.slot!.kind}${due.slot!.index}'+D+', 0).lt('+D+'${due.slot!.kind}${due.slot!.index}'+D+', args.today + 8 * DAY)).take(200)) as Doc<"records">[]).filter(r => !done || r.values[done._id] !== true).slice(0, 50) : [];','auth'),
 ('t-member-today-quiet-take-then-filter','convex/today.ts','const quiet = deal ? await quietDeals(ctx, principal, deal.object, deal.byKey.get("stage"), Date.now() - QUIET_DAYS * DAY, 20) : [];','const quiet = deal ? (await ctx.db.query("records").withIndex("by_object_updated", (q) => q.eq("orgId", args.orgId).eq("objectId", deal.object._id).lt("updatedAt", Date.now() - QUIET_DAYS * DAY)).take(200)).slice(0, 20) : [];','auth'),
 ('t-agent-today-tasks-take-then-filter','convex/agentApi.ts','const tasks = task ? await dueTasks(ctx, principal, task.object, byKey(task, "dueDate"), byKey(task, "done"), midnight + 8 * day, 50) : [];','const dueF = byKey(task, "dueDate"); const tasks = task && dueF?.slot ? ((await (ctx.db.query("records") as any).withIndex('+D+'by_${dueF.slot.kind}${dueF.slot.index}'+D+', (q: any) => q.eq("orgId", principal.org._id).eq("objectId", task.object._id).gt('+D+'${dueF.slot!.kind}${dueF.slot!.index}'+D+', 0).lt('+D+'${dueF.slot!.kind}${dueF.slot!.index}'+D+', midnight + 8 * day)).take(200)) as Doc<"records">[]).filter(r => canReadRecord(principal, task.object, r)).slice(0, 50) : [];','auth'),
 ('t-agent-today-quiet-take-then-filter','convex/agentApi.ts','const quiet = opportunity ? await quietDeals(ctx, principal, opportunity.object, byKey(opportunity, "stage"), Date.now() - 14 * day, 20) : [];','const quiet = opportunity ? (await ctx.db.query("records").withIndex("by_object_updated", (q) => q.eq("orgId", principal.org._id).eq("objectId", opportunity.object._id).lt("updatedAt", Date.now() - 14 * day)).take(200)).filter(r => canReadRecord(principal, opportunity.object, r)).slice(0, 20) : [];','auth'),
 ('t-helper-stops-after-limit-scanned','convex/authority/reads.ts','++scanned >= scanCap','++scanned >= limit','auth'),
 ('d6-guard-own-check-line-removed','ops/authority/h0-parity.test.ts','    if (!own.test(covered)) gaps.push(','    if (false) gaps.push(','auth'),
 ('d6-guard-max-shared-60','ops/authority/h0-parity.test.ts','const MAX_SHARED = 6;','const MAX_SHARED = 60;','auth'),
 ('floor-generic-message','ops/release/release.mjs',"  const ok = (...args) => spawnSync('git', args, { cwd }).status === 0;\n","  const ok = (...args) => spawnSync('git', args, { cwd }).status === 0;\n  if (!ok('merge-base', '--is-ancestor', floorSha, targetSha)) return 'Rollback target predates the I1 authority core';\n",'release'),
 ('s-member-suggestions-scan','convex/suggestions.ts','const rows = await visibleSuggestions(ctx, principal, args.status ?? "pending", 200);','const rows = (await firstVisible(ctx.db.query("suggestions").withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", args.status ?? "pending")).order("desc"), 200, async (s) => { const o = await ctx.db.get(s.change.objectId); return o && canReadRecordId(principal, o, s.change.recordId) ? s : null; }));','auth','import { visibleSuggestions } from "./authority/pending";','import { visibleSuggestions } from "./authority/pending";\nimport { firstVisible } from "./authority/reads";'),
 ('s-agent-suggestions-scan','convex/agentApi.ts','return Promise.all((await visibleSuggestions(ctx, principal, args.status ?? "pending", 100)).map(','return Promise.all((await firstVisible(ctx.db.query("suggestions").withIndex("by_org_status", (q) => q.eq("orgId", principal.org._id).eq("status", args.status ?? "pending")).order("desc"), 100, async (s) => { const o = await ctx.db.get(s.change.objectId); return o && canReadRecordId(principal, o, s.change.recordId) ? s : null; })).map(','auth','import { visibleInboxItems, visibleSuggestions } from "./authority/pending";','import { visibleInboxItems, visibleSuggestions } from "./authority/pending";\nimport { firstVisible } from "./authority/reads";'),
 ('s-member-inbox-scan','convex/inbox.ts','const rows = await visibleInboxItems(ctx, principal, args.status ?? "pending", 100);','const rows = await firstVisible(ctx.db.query("agentInbox").withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", args.status ?? "pending")).order("asc"), 100, (row) => canSeeInbox(principal, row) ? row : null);','auth',"import { visibleInboxItems } from './authority/pending';","import { visibleInboxItems } from './authority/pending';\nimport { firstVisible } from './authority/reads';"),
 ('s-agent-inbox-scan','convex/agentApi.ts','return Promise.all((await visibleInboxItems(ctx, principal, args.status ?? "pending", 100)).map(','return Promise.all((await firstVisible(ctx.db.query("agentInbox").withIndex("by_org_status", (q) => q.eq("orgId", principal.org._id).eq("status", args.status ?? "pending")).order("asc"), 100, (item) => canSeeInbox(principal, item) ? item : null)).map(','auth','import { visibleInboxItems, visibleSuggestions } from "./authority/pending";','import { visibleInboxItems, visibleSuggestions } from "./authority/pending";\nimport { firstVisible } from "./authority/reads";'),
 ('s-pending-treats-everyone-as-full','convex/authority/pending.ts','  if (everything) streams.splice(','  if (true) streams.splice(','auth'),
 ('s-inbox-shared-stream-off','convex/authority/pending.ts',"    if (sharedInboxReader(principal)) {","    if (false && sharedInboxReader(principal)) {",'auth'),
 ('s-inbox-legacy-stream-off','convex/authority/pending.ts',"      if (frozenAt !== undefined) streams.push(","      if (false) streams.push(",'auth'),
 ('o-comparator-utf16','convex/authority/reads.ts','export function compareIndexValues(a: unknown, b: unknown) { return compareValues(a as Value | undefined, b as Value | undefined); }','const rank = (v: unknown) => v === undefined ? 0 : v === null ? 1 : typeof v === "number" ? 2 : typeof v === "boolean" ? 3 : 4;\nexport function compareIndexValues(a: unknown, b: unknown) { void compareValues; const d = rank(a) - rank(b); return d || ((a as any) < (b as any) ? -1 : (a as any) > (b as any) ? 1 : 0); }','auth'),
 ('o-minus0-equals-0','convex/authority/reads.ts','export function compareIndexValues(a: unknown, b: unknown) { return compareValues(','export function compareIndexValues(a: unknown, b: unknown) { if (a === b) return 0; return compareValues(','auth'),
 ('g-list-ignores-filter','convex/lib/list.ts','      if (filter) rows = rows.filter(','      if (false) rows = rows.filter(','auth'),
 ('g-list-ignores-descending','convex/lib/list.ts','      if (sort?.direction === "desc") rows.reverse();','','auth'),
 ('g-list-drops-tiebreak','convex/lib/list.ts','rows = [...rows].sort((a, b) => compareIndexValues(at(a), at(b)) || a._creationTime - b._creationTime);','rows = [...rows].sort((a, b) => compareIndexValues(at(a), at(b)));','auth'),
 ('g-quiet-list-path-off','convex/lib/daily.ts','  const listed = await listedRecords(ctx, principal, deal);','  const listed = null as Doc<"records">[] | null;','auth'),
 ('c-cursor-prefix-check-off','convex/authority/reads.ts',"  if ([opts.cursor, opts.endCursor].some(c => typeof c === 'string' && /^(list|events):/.test(c))) fail('VALIDATION', 'Invalid cursor');\n",'','auth'),
 ('c-cursor-catch-off','convex/authority/reads.ts',"  try { return await query.paginate(opts); } catch (error) { if (/cursor/i.test(String((error as Error)?.message ?? error))) fail('VALIDATION', 'Invalid cursor'); throw error; }","  return await query.paginate(opts);",'auth'),
]
only=sys.argv[1] if len(sys.argv)>1 else None
out={}
for name,path,old,new,suite,*imp in M:
    if only and not re.search(only,name): continue
    src=open(path).read()
    assert src.count(old)==1,(name,src.count(old))
    out_src=src.replace(old,new)
    if imp: assert out_src.count(imp[0])==1,(name,'imp'); out_src=out_src.replace(imp[0],imp[1])
    open(path,'w').write(out_src)
    try:
        cmd=['pnpm','-s','test:authority'] if suite=='auth' else ['pnpm','-s','verify:release']
        r=subprocess.run(cmd,capture_output=True,text=True,timeout=600)
    finally:
        open(path,'w').write(src)
    log=r.stdout+r.stderr
    log=re.sub(r'[0-9a-f]{64}','<sha256>',log)
    open(f'evidence/2026-09-25-i1/revision-4/reds/{name}.log','w').write(log)
    failed=sorted(set(re.findall(r'FAIL\s+(\S+ > .+)',log)))+sorted(set(re.findall(r'^✖ (.+?) \(\d',log,re.M)))
    out[name]={'exit':r.returncode,'failed':failed}
    print(name,'exit',r.returncode,'CAUGHT' if r.returncode else 'MISSED'); [print('   ',f[:150]) for f in failed]
json.dump(out,open('evidence/2026-09-25-i1/revision-4/reds/mutants.json','w'),indent=1)
print('clean' if subprocess.run(['git','diff','--quiet','--','convex','ops'],capture_output=True).returncode in (0,1) else '')
