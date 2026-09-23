# Remold MCP

This package connects an AI agent to Remold's REST API. It reads CRM data, proposes changes for a person to apply, applies only granted changes, and drains the shared inbox.

Build it with `pnpm --filter @remold/mcp build`.

Claude Code:

```sh
claude mcp add remold -e REMOLD_URL=https://your-deployment.convex.site -e REMOLD_KEY=rm_your_key -- node /absolute/path/to/remold/packages/mcp/dist/index.js
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.remold]
command = "node"
args = ["/absolute/path/to/remold/packages/mcp/dist/index.js"]
env = { REMOLD_URL = "https://your-deployment.convex.site", REMOLD_KEY = "rm_your_key" }
```

REST example:

```sh
curl -H 'Authorization: Bearer rm_your_key' https://your-deployment.convex.site/api/v1/me
```
