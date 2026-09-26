import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['ops/authority/**/*.test.ts'] } });
