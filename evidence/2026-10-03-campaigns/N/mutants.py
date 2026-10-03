import subprocess, sys
M = [
 # Round 2 (independent verification findings 1 to 3)
 ("suspended keys accepted", "convex/identity.ts", "agent.revokedAt !== undefined || (agent.state !== undefined && agent.state !== \"active\")) fail(\"UNAUTHENTICATED\"", "agent.revokedAt !== undefined) fail(\"UNAUTHENTICATED\""),
 ("intake-only keys accepted", "convex/identity.ts", "if (agent.purpose !== undefined && agent.purpose !== purpose)", "if (false)"),
 ("path ids not escaped", "packages/mcp/src/tools.ts", "const id = encodeURIComponent;", "const id = (value: string) => value;"),
 ("initialize params not checked", "convex/mcp.ts", 'if (typeof params.protocolVersion !== "string" || !isObject(params.capabilities)', 'if (false && (typeof params.protocolVersion !== "string" || !isObject(params.capabilities))'),
 ("clientInfo fields not checked", "convex/mcp.ts", '|| typeof info.name !== "string" || typeof info.version !== "string")', ")"),
 ("response with both result and error accepted", "convex/mcp.ts", '("result" in message) !== ("error" in message)', '("result" in message || "error" in message)'),
 ("bad id on a response accepted", "convex/mcp.ts", 'if ("id" in message && !validId) return invalid();', ""),
 ("valid client responses refused", "convex/mcp.ts", "return answered ? new Response(null, { status: 202 }) : invalid();", "return invalid();"),
 ("no key check on messages", "convex/mcp.ts", "try { await ctx.runQuery(internal.agentApi.checkKey, { keyHash: await rest.keyHash() }); }", "try { await rest.keyHash(); }"),
 ("no Origin refusal", "convex/mcp.ts", 'if (request.headers.get("origin") !== null)', "if (false)"),
 ("batches accepted as first message", "convex/mcp.ts", "if (Array.isArray(message)) return", "if (Array.isArray(message)) message = message[0]; if (false) return"),
 ("unknown tool as method-not-found", "convex/mcp.ts", "error(id, -32602, `Unknown tool", "error(id, -32601, `Unknown tool"),
 ("idempotency header dropped", "convex/mcp.ts", '...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }), ', ""),
 ("GET and DELETE not 405", "convex/mcp.ts", 'if (request.method !== "POST") return new Response(null, { status: 405', 'if (request.method !== "POST") return new Response(null, { status: 400'),
 ("initialize ignores requested version", "convex/mcp.ts", "protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0]", "protocolVersion: versions[0]"),
 ("protocol header not checked", "convex/mcp.ts", "if (version !== null && !versions.includes(version))", "if (false)"),
 ("REST body validation skipped", "convex/http.ts", "if (!ids || (ids.length", "if (false && (ids.length"),
 ("write rate limit off", "convex/http.ts", 'const limit = request.method === "POST" && path[0] !== "intake"', 'const limit = false'),
 ("mcp not measured", "convex/http.ts", "const mcpRoute = measured((ctx, request) =>", "const mcpRoute = httpAction((ctx, request) =>"),
 ("schema required ignored", "packages/mcp/src/tools.ts", "for (const key of (schema.required ?? []) as string[]) if", "for (const key of [] as string[]) if"),
 ("unknown keys kept", "packages/mcp/src/tools.ts", "if (!inner || item === undefined) continue;", "if (!inner) { out.push([key, item]); continue; } if (item === undefined) continue;"),
 ("maxItems ignored", "packages/mcp/src/tools.ts", 'typeof schema.maxItems === "number" &&', "false &&"),
 ("integers not checked", "packages/mcp/src/tools.ts", "Number.isSafeInteger(value) ? { value }", "typeof value === \"number\" ? { value }"),
 ("hosted list drops a tool", "convex/mcp.ts", "result({ tools: toolList })", "result({ tools: toolList.slice(1) })"),
 ("hosted instructions differ", "convex/mcp.ts", "capabilities, serverInfo, instructions });", "capabilities, serverInfo, instructions: instructions.slice(1) });"),
 ("stdio idempotency header dropped", "packages/mcp/src/client.ts", '...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }), ', ""),
]
tests = ["convex/mcp.test.ts", "packages/mcp/src/client.test.ts"]
caught = 0
for name, path, old, new in M:
    src = open(path).read()
    assert src.count(old) == 1, (name, src.count(old))
    open(path, "w").write(src.replace(old, new))
    try:
        r = subprocess.run(["pnpm", "exec", "vitest", "run", "convex/mcp.test.ts"], capture_output=True, text=True)
        r2 = subprocess.run(["pnpm", "--dir", "packages/mcp", "test"], capture_output=True, text=True)
        killed = r.returncode != 0 or r2.returncode != 0
        r.stdout += r.stderr + r2.stdout + r2.stderr
        fails = sorted({l.strip().split(" > ")[-1] for l in r.stdout.splitlines() if l.strip().startswith("FAIL") and " > " in l})[:3]
    finally:
        open(path, "w").write(src)
    caught += killed
    print(("CAUGHT " if killed else "SURVIVED ") + name, "|", " ; ".join(f[:140] for f in fails), flush=True)
print(f"{caught}/{len(M)} caught")
