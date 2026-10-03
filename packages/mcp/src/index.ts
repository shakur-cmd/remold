#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { httpSend } from "./client.js";
import { stdioServer } from "./server.js";

declare const process: { env: Record<string, string | undefined>; exit(code: number): never; };
const url = process.env.REMOLD_URL, key = process.env.REMOLD_KEY;
if (!url || !key) { console.error("REMOLD_URL and REMOLD_KEY are required"); process.exit(1); }
await stdioServer(httpSend({ url, key })).connect(new StdioServerTransport());
