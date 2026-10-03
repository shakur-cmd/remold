import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callTool, capabilities, instructions, serverInfo, toolList, type Send } from "./tools.js";

export function stdioServer(send: Send) {
  const server = new Server(serverInfo, { capabilities, instructions });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolList }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const result = await callTool(params.name, params.arguments, send);
    // A plain error with a code: McpError would prefix its message, and the hosted endpoint sends it bare.
    if (!result) throw Object.assign(new Error(`Unknown tool: ${params.name}`), { code: ErrorCode.InvalidParams });
    return result;
  });
  return server;
}
