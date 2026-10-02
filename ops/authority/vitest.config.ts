import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['ops/authority/**/*.test.ts'], env: { REMOLD_OPEN_SIGNUP: '1', REMOLD_PAYMENT_CALLBACKS: '1' } } });
