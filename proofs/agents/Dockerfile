FROM ghcr.io/paperclipai/paperclip@sha256:52510c246809a1c0978e67e39a855bff6c9cfdfe2114f115791ab0add15d1411
# Prepare the upstream library aliases before enforcing a read-only runtime.
RUN node --import ./server/node_modules/tsx/dist/loader.mjs --input-type=module -e 'import { prepareEmbeddedPostgresNativeRuntime } from "./packages/db/src/embedded-postgres-native.ts"; await prepareEmbeddedPostgresNativeRuntime();'
