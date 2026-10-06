# Privacy

mcp-pin collects no personal data. It has no accounts, no telemetry, no analytics and no tracking cookies.

## The command-line tool, the proxy and the plugin

- **What stays on your machine.** Pins, approvals, the lockfile and logs are written under `~/.mcp-pin` (or `MCP_PIN_HOME`), or in your project when you run `mcp-pin lock`. Nothing from them is uploaded.
- **The Claude Code plugin.** Its SessionStart check reads `~/.claude.json` and `.mcp.json` to list servers that run without mcp-pin. It makes no network request and only prints the server names in your session.
- **Network requests mcp-pin makes, and only these:**
  - `mcp-pin lookup` fetches the public log summary from `https://mcp-pin.gautamkhosla.com/api/servers.json`. The request carries no identifier and no information about your servers; the lookup happens on your machine.
  - Package pinning (`lock`, and the proxy with `--lock`) asks the npm registry (`registry.npmjs.org`, or the registry you configured) or PyPI (`pypi.org`) for the version and digest of the package you pinned.
  - MCP servers you run through the proxy talk to whatever they talk to. mcp-pin passes their traffic through and does not send it anywhere else.
- `npx` downloads mcp-pin itself from npm. npm's own privacy policy covers that.

## The website

mcp-pin.gautamkhosla.com is a static site on Cloudflare Pages. It sets no cookies, loads nothing from third parties and runs no analytics. Its Content Security Policy also blocks Cloudflare's optional analytics beacon. Cloudflare, as the host, processes request data such as IP addresses to serve and protect the site, under [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/).

The public log on the site lists public MCP servers and their published tool definitions. It contains nothing about the people who use mcp-pin.

## Contact

Questions: open an issue at https://github.com/GautamTalksDev/mcp-pin/issues. For anything private, use GitHub's private reporting described in [SECURITY.md](SECURITY.md).

Last updated: 6 October 2026.
