# Installing mcp-pin (for AI agents)

Steps for an AI agent that is setting up mcp-pin for a user. Requires Node.js 20 or newer.

## 1. Add the lookup server

Add this entry to the client's MCP configuration (for Cline: `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "mcp-pin": {
      "command": "npx",
      "args": ["-y", "mcp-pin@0.2.3", "lookup"]
    }
  }
}
```

No API key and no environment variables are needed. Keep the exact version: mcp-pin's whole point is that what was approved does not change underneath the user.

On Windows, if the client cannot start `npx` directly, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "mcp-pin@0.2.3", "lookup"]`.

## 2. Check it works

The server exposes four read-only tools. Call `mcp_pin_server_status` with `{"query": "firecrawl"}`. It should return `firecrawl-mcp` with a tool count and dates. The client may need a restart, or a new task, before the tools appear.

## 3. Protect the user's other servers (only if they ask)

The lookup server only reads. To actually pin and protect the user's MCP servers, the user runs this in a terminal:

```
npx -y mcp-pin@0.2.3 wrap
```

It shows its plan, backs up each config file and asks before writing anything. Do not run it without the user's consent, and never run `mcp-pin approve` for them: approving a changed server is the user's decision.

## What it reads and sends

- One network request: a GET of `https://mcp-pin.gautamkhosla.com/api/servers.json`, the public log summary. Nothing about the user's machine is sent.
- Local reads of `~/.mcp-pin` for the user's own pins.
- No telemetry. Details: [PRIVACY.md](PRIVACY.md).
