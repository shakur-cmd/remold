#!/bin/bash
# Release flow for one commit: build+seal, synthetic backup, restore receipt, preflight.
set -uo pipefail
REPO="$1"; SHA="$2"; BASE="$3"; OUT="$4"
cd "$REPO"
rm -rf "$OUT"; mkdir -p "$OUT"
export VITE_CONVEX_URL=https://release-fixture.invalid VITE_WORKOS_CLIENT_ID=client_releasefixture
node ops/release/release.mjs build "$OUT/artifact" "$SHA" "$BASE" ops/release/notes.json > "$OUT/build.txt" 2>&1 || { echo "build failed"; tail -5 "$OUT/build.txt"; exit 1; }
PIN=$(shasum -a 256 "$OUT/artifact/release-manifest.json" | cut -d' ' -f1)
echo "pin $PIN"
node ops/release/release.mjs verify "$OUT/artifact" "$SHA" "$PIN" > "$OUT/verify.txt" 2>&1; echo "verify exit $?"
node --input-type=module -e "import { seedSnapshot } from './ops/release/snapshot.mjs'; await seedSnapshot({ source: process.cwd(), out: '$OUT/synthetic-backup.zip' });" > "$OUT/seed.txt" 2>&1; echo "seed exit $?"
echo "--- preflight without receipt"
node ops/release/release.mjs preflight "$OUT/artifact" "$SHA" "$PIN" > "$OUT/preflight-no-receipt.txt" 2>&1; echo "exit $?"; cat "$OUT/preflight-no-receipt.txt"
node ops/release/release.mjs snapshot "$OUT/artifact" "$SHA" "$PIN" "$REPO" "$OUT/synthetic-backup.zip" "$OUT/receipt.json" > "$OUT/snapshot.txt" 2>&1; echo "snapshot exit $?"
echo "--- preflight with receipt and backup"
node ops/release/release.mjs preflight "$OUT/artifact" "$SHA" "$PIN" "$OUT/receipt.json" "$OUT/synthetic-backup.zip" > "$OUT/preflight.txt" 2>&1; echo "exit $?"; cat "$OUT/preflight.txt"
