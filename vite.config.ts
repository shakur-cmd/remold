/// <reference types="vitest/config" />
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  // Fixtures run with the production gates open; workspaces.test.ts and paymentCallbacks.test.ts cover them closed.
  test: { include: ["convex/**/*.test.ts", "src/**/*.test.ts", "ops/import/*.test.ts"], env: { REMOLD_OPEN_SIGNUP: "1", REMOLD_PAYMENT_CALLBACKS: "1" } },
});
