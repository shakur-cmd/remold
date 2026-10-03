// Ready-to-paste MCP setup for one new agent key. Keep the invocations in step with packages/mcp/README.md.
// Hosted forms come first: the deployment serves MCP at <site>/mcp, so a URL and the key are all an agent needs.
// The stdio forms run packages/mcp from a checkout, for offline and development use.
const ENTRY = "/absolute/path/to/remold/packages/mcp/dist/index.js";

export function agentSetup(url: string, key: string) {
  const endpoint = `${url}/mcp`, authorization = `Bearer ${key}`;
  const env = { REMOLD_URL: url, REMOLD_KEY: key }, server = { command: "node", args: [ENTRY], env };
  return {
    hostedClaudeCommand: `claude mcp add --transport http remold ${endpoint} --header "Authorization: ${authorization}"`,
    hostedCodex: `[mcp_servers.remold]\nurl = "${endpoint}"\nhttp_headers = { "Authorization" = "${authorization}" }`,
    hostedJson: JSON.stringify({ mcpServers: { remold: { type: "http", url: endpoint, headers: { Authorization: authorization } } } }, null, 2),
    claudeCommand: `claude mcp add remold -e REMOLD_URL=${url} -e REMOLD_KEY=${key} -- node ${ENTRY}`,
    claudeJson: JSON.stringify({ mcpServers: { remold: { type: "stdio", ...server } } }, null, 2),
    codex: `[mcp_servers.remold]\ncommand = "node"\nargs = ["${ENTRY}"]\nenv = { REMOLD_URL = "${url}", REMOLD_KEY = "${key}" }`,
    generic: JSON.stringify({ mcpServers: { remold: server } }, null, 2),
    test: "Ask your agent: what is in my Remold workspace?",
  };
}
