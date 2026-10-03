import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "baseline", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: [process.argv[2]], env: { ...process.env, REMOLD_URL: "http://127.0.0.1:9", REMOLD_KEY: "rm_x" } }));
const tools = await client.listTools();
const bad = await client.callTool({ name: "remold_get_record", arguments: { idOrRef: 5 } }).catch(e => ({ thrown: String(e) }));
const unknown = await client.callTool({ name: "nope", arguments: {} }).catch(e => ({ thrown: String(e) }));
console.log(JSON.stringify({ instructions: client.getInstructions(), serverVersion: client.getServerVersion(), capabilities: client.getServerCapabilities(), tools: tools.tools, bad, unknown }, null, 1));
await client.close();
