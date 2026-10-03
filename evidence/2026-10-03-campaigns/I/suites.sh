#!/bin/sh
# Full-suite summary lines for the handover. Run from the repo root: sh evidence/2026-10-03-campaigns/I/suites.sh
echo "pnpm test:"; pnpm test 2>&1 | grep -E "Test Files|Tests "
echo "pnpm typecheck:"; pnpm typecheck >/dev/null 2>&1 && echo "clean (exit 0)" || echo "FAILED"
echo "pnpm test:authority:"; pnpm test:authority 2>&1 | grep -E "Test Files|Tests "
echo "pnpm verify:release:"; pnpm verify:release 2>&1 | grep -E "^ℹ (tests|pass|fail)"
echo "pnpm build:"; pnpm build 2>&1 | grep -E "built in|error"
echo "pnpm --dir packages/mcp test:"; pnpm --dir packages/mcp test 2>&1 | grep -E "Tests "
echo "convex/automations.test.ts:"; pnpm exec vitest run convex/automations.test.ts 2>&1 | grep -E "Tests "
