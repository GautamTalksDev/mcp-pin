# mcp-pin for Claude

Know when an MCP server's tools change after you approved them.

MCP tool descriptions are instructions to the model. A server can change them at any time after you approved it, and most clients never ask you again. This plugin helps Claude check a server before you trust it, tells you which local servers run unprotected, and explains a block when [mcp-pin](https://github.com/GautamTalksDev/mcp-pin) stops a server whose definitions changed.

## What it adds

- **A skill** that teaches Claude to check an MCP server before you rely on it, to set up mcp-pin when you ask, and to explain an "mcp-pin blocked" error and how to review the change.
- **Four read-only MCP tools** from `mcp-pin lookup`:
  - `mcp_pin_server_status`: whether a public MCP server's tool definitions changed recently, from the public log
  - `mcp_pin_my_servers`: the servers mcp-pin has pinned on this machine, and whether any is waiting for review
  - `mcp_pin_change_summary`: what kind of change a blocked server made, as labels only
  - `mcp_pin_how_to_protect`: setup steps for your MCP client
- **A session-start note** that names the local MCP servers in your Claude Code setup that run without mcp-pin, if there are any.

## What it runs, reads and sends

Everything the plugin does, so you can check it:

- **The lookup server** starts with `npx -y mcp-pin@0.2.3 lookup`. The first start downloads that exact version of the `mcp-pin` package from the npm registry.
- **One network request:** `mcp_pin_server_status` fetches the public log summary from `https://mcp-pin.gautamkhosla.com/api/servers.json`. Nothing about your machine or your servers is sent; the request only carries a `mcp-pin-lookup/<version>` user agent.
- **Local reads:** `mcp_pin_my_servers` and `mcp_pin_change_summary` read mcp-pin's pin store in `~/.mcp-pin` (or `MCP_PIN_HOME`). They never send it anywhere.
- **The session-start hook** runs `node ${CLAUDE_PLUGIN_ROOT}/scripts/check-unprotected.js`. It reads `~/.claude.json` and the project's `.mcp.json` to list local stdio servers that are not wrapped with mcp-pin, prints one line with their names, changes nothing and makes no network call.
- **No third-party text reaches the model.** The tools return names, dates, counts and change labels, never another server's tool descriptions, so a hostile description cannot ride along.
- **No telemetry.** The plugin collects nothing.

The plugin does not install the mcp-pin proxy or change your client configuration on its own. If you want your servers protected, the skill shows you the command, `npx -y mcp-pin@0.2.3 wrap`, which displays its plan and asks before it writes anything.

## Install

```
claude plugin marketplace add GautamTalksDev/mcp-pin
claude plugin install mcp-pin@mcp-pin
```

### In Cursor

The same folder is a Cursor plugin (`.cursor-plugin/plugin.json`): it adds the four lookup tools and the skill. The session-start note reads Claude Code's config, so Cursor does not run it. To try it before it is in the Cursor marketplace, copy this folder to `~/.cursor/plugins/local/mcp-pin` and restart Cursor.

## Links

- Source and full documentation: https://github.com/GautamTalksDev/mcp-pin
- The public log: https://mcp-pin.gautamkhosla.com/log/
- Security policy: https://github.com/GautamTalksDev/mcp-pin/blob/main/SECURITY.md

MIT licensed. An independent open-source project, not affiliated with Anthropic or the Model Context Protocol project.
