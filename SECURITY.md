# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private reporting: **Security → Advisories → Report a vulnerability** on this repository. That channel is monitored and is the fastest route.

What helps:

- What you can do that you should not be able to do
- Steps to reproduce, ideally a minimal MCP server or a log fragment
- Which component: proxy, crawler, log, or site
- Whether you have published anything about it already

### What to expect

| Stage | Target |
|---|---|
| Acknowledgement | 72 hours |
| Initial assessment | 7 days |
| Fix or documented mitigation | 30 days for high severity |
| Public advisory | Coordinated with you |

This project is maintained by one person alongside university study. Those targets are honest intentions, not a contractual SLA, and pretending otherwise would be the first security failure.

Credit is given in the advisory unless you prefer otherwise. There is no bug bounty. If that changes it will be announced here.

## Scope

**In scope**

- The proxy failing to detect a change it claims to detect
- Any way to make the proxy pass poisoned metadata to a client
- SSRF, code execution, or privilege escalation in the crawler
- Log entries that verify despite being tampered with
- Cross site scripting or content injection on the generated site
- Signing key handling, and any path that lets an unsigned head be accepted

**Out of scope**

- Malicious MCP servers themselves. Report those to the registry hosting them
- Prompt injection through tool *results*, which this project does not claim to address
- Social engineering of a user into approving a diff
- Rate limits or availability of the public site
- Findings that require an already compromised machine

## Supported versions

The most recent published version only. This is a pre 1.0 project and there are no backports.

## Design commitments

These are properties the project intends to preserve. A change that breaks one is a security regression, not a feature.

1. **No model is in the trust path.** The verification decision is a hash comparison. An optional local summariser may describe a diff in English, clearly labelled non authoritative, and it never decides anything.
2. **No network egress from the proxy by default.** Pinning is local. Submitting observations to the public log is opt in.
3. **No credentials are read, transmitted, or logged.** The crawler runs with a minimal environment and the proxy touches only its own state directory.
4. **The signing key never sits on a machine that executes untrusted code.**
5. **Failure blocks.** If the proxy cannot verify, it stops the session rather than passing it through. Fail closed, always.
6. **Zero runtime dependencies.** A supply chain tool with a large dependency tree undermines its own argument.

## Running the crawler safely

`--allow-exec` makes the crawler download and execute third party npm packages. Treat it as running untrusted code, because it is.

Do not run it on a personal machine. Run it on a disposable CI runner with no credentials mounted beyond a read only token, and never on a host that holds the log signing key. HTTP probing needs no flag and executes nothing.

Full analysis: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
