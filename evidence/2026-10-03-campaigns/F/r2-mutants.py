# The verifier's 12 mutants (iv-F-verdict.md S1), applied one at a time against the
# view tests; each file is restored from a copy afterwards. Run from the repo root.
import shutil, subprocess
M = [
 ("M1 agent runs a personal view", "convex/agentApi.ts", "view.orgId !== principal.org._id || view.ownerId || ", "view.orgId !== principal.org._id || "),
 ("M2 board/calendar field not a row field", "convex/lib/views.ts", ', ...(spec.layout === "board" ? [spec.groupFieldId!] : []), ...(spec.layout === "calendar" ? [spec.dateFieldId!] : [])', ""),
 ("M3 views.list ignores object read", "convex/views.ts", "if (!object || archived(object) || !canReadObject(principal, object)) continue;", "if (!object || archived(object)) continue;"),
 ("M4 runView skips hidden-field block", "convex/lib/views.ts", "if (!rowFields(spec).every((id) => canQueryField(principal, object, fields.get(id)!))) fail", "if (false) fail"),
 ("M5 forReader shows an unreadable range", "convex/lib/views.ts", "...(range && reads(range.fieldId) ? { range } : {})", "...(range ? { range } : {})"),
 ("M6 forReader shows an unreadable sort", "convex/lib/views.ts", "...(sort && reads(sort.fieldId) ? { sort } : {})", "...(sort ? { sort } : {})"),
 ("M7 member can share a view", "convex/views.ts", "if (options.shared && !isAdmin(principal)) fail", "if (false) fail"),
 ("M8 member can update a shared view", "convex/views.ts", "{ view, object } = await editable(ctx, principal, viewId);", "{ view, object } = await visible(ctx, principal, viewId);"),
 ("M9 addView authorize ignores hidden fields", "convex/shapeSuggestions.ts", " || fields.some((field) => field && !canReadField(principal, object, field))", ""),
 ("M10 checkView lets an unreadable column through", "convex/lib/views.ts", "  view.columns.forEach(readable);\n", ""),
 ("M11 personal view can be pinned", "convex/views.ts", 'if (options.pinned && !options.shared) fail', 'if (false) fail'),
 ("M12 isDay accepts anything", "convex/lib/views.ts", "const isDay = (day: string | undefined) => day === undefined || (", "const isDay = (day: string | undefined) => true || ("),
]
killed = 0
for name, path, a, b in M:
    src = open(path).read(); assert src.count(a) >= 1, name
    shutil.copy(path, "/tmp/r2mut.bak"); open(path, "w").write(src.replace(a, b, 1))
    out = subprocess.run(["pnpm", "vitest", "run", "convex/views.test.ts", "convex/lib/days.test.ts", "--testTimeout=60000"], capture_output=True, text=True).stdout
    shutil.copy("/tmp/r2mut.bak", path)
    summary = [l.strip() for l in out.splitlines() if "Tests " in l]
    dead = "failed" in (summary[-1] if summary else "")
    killed += dead
    print(f"{'killed' if dead else 'SURVIVED'}  {name}  ({summary[-1] if summary else 'no summary'})", flush=True)
print(f"{killed}/{len(M)} killed")
