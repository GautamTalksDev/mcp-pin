# Support

mcp-pin is an independent open-source project, maintained by one person. This page says what you can expect, so you can decide whether that is enough for your team.

## Where to ask

- **Bugs and questions:** [open an issue](https://github.com/GautamTalksDev/mcp-pin/issues). Include your MCP client and its version, your operating system, the mcp-pin version (`npx -y mcp-pin@<version> --version` or the version you pinned), and what you saw.
- **Security problems:** never in a public issue. Use private reporting, as [SECURITY.md](SECURITY.md) describes: acknowledgement within 72 hours, an initial assessment within 7 days, and a fix or documented mitigation within 30 days for high severity.
- **Teams evaluating mcp-pin:** open an issue titled "Evaluation:" with what you need (a lockfile in CI, policy packs for your clients, a question about the threat model). Answers stay public, so the next team benefits too.

Everything else is best effort. There is no paid support and no SLA.

## Supported versions

The latest release receives fixes. Pin an exact version (`mcp-pin@0.2.2`, never `@latest`), read the [changelog](CHANGELOG.md) before you move, and use `mcp-pin lock --check` in CI so an upgrade of a server, or of mcp-pin, is reviewed in a pull request.

## If this project stops

You should not have to trust that one maintainer stays around:

- **MIT licensed** with zero runtime dependencies, so you can vendor it or fork it as it is.
- **An open spec.** The [tool definition hash](docs/TOOL_DEFINITION_HASH.md) has test vectors and a second, independent implementation in Python, so another tool can compute the same fingerprints and read the same pins.
- **Verifiable data.** The public log is hash linked and signed, and `mcp-pin verify-log` checks a downloaded copy without contacting anyone.
- **Release provenance.** Every npm release since 0.2.0 is built in GitHub Actions with signed provenance, so you can check that the package came from this repository.
