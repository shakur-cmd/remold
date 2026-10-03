// Ready-to-paste MCP setup for one new agent key. Keep the invocation in step with packages/mcp/README.md.
const ENTRY = "/absolute/path/to/remold/packages/mcp/dist/index.js";

export function agentSetup(url: string, key: string) {
  const env = { REMOLD_URL: url, REMOLD_KEY: key }, server = { command: "node", args: [ENTRY], env };
  return {
    claudeCommand: `claude mcp add remold -e REMOLD_URL=${url} -e REMOLD_KEY=${key} -- node ${ENTRY}`,
    claudeJson: JSON.stringify({ mcpServers: { remold: { type: "stdio", ...server } } }, null, 2),
    codex: `[mcp_servers.remold]\ncommand = "node"\nargs = ["${ENTRY}"]\nenv = { REMOLD_URL = "${url}", REMOLD_KEY = "${key}" }`,
    generic: JSON.stringify({ mcpServers: { remold: server } }, null, 2),
    test: "Ask your agent: what is in my Remold workspace?",
  };
}
