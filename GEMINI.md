# mcp-pin

MCP tool descriptions are instructions to the model, and a server can change them after the user approved it. mcp-pin pins the definitions of each server and blocks the session when they change. This extension adds mcp-pin's read-only lookup tools:

- `mcp_pin_server_status`: before the user installs or approves a public MCP server, check whether its tool definitions changed recently and when, from mcp-pin's signed public log. An unchanged server is not proof of safety.
- `mcp_pin_my_servers`: which servers mcp-pin protects on this machine, and whether any has a change waiting for review.
- `mcp_pin_change_summary`: what kind of change a blocked server made, as labels only. The user reads the actual diff in a terminal with `mcp-pin review <id>`.
- `mcp_pin_how_to_protect`: the exact setup steps for an MCP client.

Approving a change is always the user's decision. Never run `mcp-pin approve` for them.

To protect the MCP servers configured in Gemini CLI, the user can run `npx -y mcp-pin@0.2.2 wrap`, which shows its plan and asks before it changes anything. Source and documentation: https://github.com/GautamTalksDev/mcp-pin
