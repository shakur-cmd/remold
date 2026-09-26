import { McpServer } from '../../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import { StdioServerTransport } from '../../../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import { z } from '../../../packages/mcp/node_modules/zod/index.js';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';

const token = process.env.REMOLD_PROOF_TOKEN;
if (!token) throw Error('Synthetic proof credential required');
const client = new ConvexHttpClient('http://127.0.0.1:3500', { logger: false });
const server = new McpServer({ name: 'remold-native-proof', version: '1' });
for (const [name, method, reference] of [
  ['read_task', 'query', 'runner:task'],
  ['start_task', 'mutation', 'runner:start'],
]) {
  server.registerTool(name, { inputSchema: { id: z.string() } }, async ({ id }) => {
    try {
      const value = await client[method](makeFunctionReference(reference), { token, id });
      return { content: [{ type: 'text', text: JSON.stringify(value ?? { accepted: true }) }] };
    } catch {
      return { isError: true, content: [{ type: 'text', text: 'Task operation unavailable for this principal' }] };
    }
  });
}
await server.connect(new StdioServerTransport());
