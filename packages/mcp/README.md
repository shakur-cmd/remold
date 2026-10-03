# Remold MCP

Remold's MCP tools let an AI agent read CRM data, propose changes for a person to apply, apply only granted changes, and drain the shared inbox. Start with `remold_map`: one call returns the objects, fields, counts, your access and what you can do here. Then `remold_inbox`.

In Remold, Settings, Agents, creating a key shows these snippets with your URL and key filled in.

## Hosted (the default)

Every Remold deployment serves the tools itself at `<site>/mcp` over Streamable HTTP. Connecting an agent is the URL and an agent key. Nothing to install or build.

Claude Code:

```sh
claude mcp add --transport http remold https://your-deployment.convex.site/mcp --header "Authorization: Bearer rm_your_key"
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.remold]
url = "https://your-deployment.convex.site/mcp"
http_headers = { "Authorization" = "Bearer rm_your_key" }
```

Other clients:

```json
{"mcpServers":{"remold":{"type":"http","url":"https://your-deployment.convex.site/mcp","headers":{"Authorization":"Bearer rm_your_key"}}}}
```

The endpoint is stateless: JSON responses, no sessions, no SSE stream (GET and DELETE return 405). It speaks MCP 2025-03-26, 2025-06-18 and 2025-11-25.

## Local stdio (offline and development)

This package runs the same tools as a local stdio server that calls the REST API. `src/tools.ts` is the one tool registry; the hosted endpoint (`convex/mcp.ts`) serves the same file.

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

## REST

```sh
curl -H 'Authorization: Bearer rm_your_key' https://your-deployment.convex.site/api/v1/me
```
