# Architecture

Four moving parts, one shared hashing rule. Everything else follows from that.

```mermaid
flowchart TB
    CAN["src/canonical.js<br/>RFC 8785 canonicalization + SHA-256"]
    CAN --> PROXY["bin/attest.js<br/>the proxy"]
    CAN --> CRAWL["crawler/<br/>discovery, probing, log"]
    CRAWL --> SITE["site/build.js<br/>static output"]
    PROXY --> STORE["src/store.js<br/>local pins + local log"]
```

If the canonicalization rule were ambiguous, every other component would disagree with itself over time. That is why it is one small file with the most tests.

## src/canonical.js

Turns a tool object into exactly one string, then hashes it.

- Object keys sorted by UTF-16 code unit, per RFC 8785
- No insignificant whitespace
- Arrays keep their order, objects do not depend on it
- `fingerprintTool` hashes one tool; `fingerprintToolset` sorts per tool hashes by name and hashes the concatenation, so additions and removals move the set hash

The set hash exists because a rug pull that *adds* a tool is the same attack as one that mutates a tool. Per tool hashing alone would miss it.

## bin/attest.js, the proxy

A stdio shim. Client on one side, server on the other, JSON-RPC lines flowing through.

```mermaid
sequenceDiagram
    participant C as client
    participant P as mcp-pin
    participant S as server

    C->>P: initialize
    P->>S: initialize
    S-->>P: result
    P-->>C: result
    Note over P: probe immediately, before the client can act
    P->>S: tools/list (id: attest-probe)
    S-->>P: tools
    alt fingerprint matches the pin
        P->>P: swallow the probe, continue normally
    else fingerprint differs
        P-->>C: JSON-RPC error
        P->>P: print diff, kill the server, exit 42
    end
```

The proxy issues **its own** `tools/list` immediately after initialize rather than waiting for the client's. This matters: if you wait, the poisoned definitions have already reached the model by the time you notice. Blocking after the model has read the payload is not blocking.

State lives in `~/.mcp-pin`: `pins.json` for current fingerprints and `log.ndjson` for a local hash linked history.

## crawler/

| File | Job |
|---|---|
| `discover.js` | Find servers: npm keyword search, the MCP registry, GitHub topic `mcp-server` |
| `probe.js` | Get `tools/list` over stdio or HTTP, with install, retry, and validation |
| `log.js` | Append only hash linked log with Ed25519 signed heads |
| `badge.js` | Deterministic SVG, pure function so it works in a build or a Worker |
| `security.js` | SSRF guard, byte caps, toolset validation, identifier validation |
| `crawl.js` | Orchestration, opt out, pacing, state |

Two deliberate choices worth explaining.

**Install then run, not `npx`.** `npx` cold resolves on every invocation, which times out under any concurrency. The crawler installs into a scratch prefix with `--ignore-scripts`, reads the manifest, and executes the declared bin directly. Installs are serialized because npm's cache is not safe under heavy parallelism, which cost a full debugging cycle to discover.

**Change log, not heartbeat log.** An entry is appended only when a fingerprint differs from the last recorded one. Liveness lives in `state.json`. A server that never changes has exactly one entry forever, and the log stays small enough to download and verify by hand.

## site/build.js

Reads the log and state, writes static files. No server, no database, no runtime.

```
public/
├── index.html              searchable server list
├── servers/<id>.html       history, rendered diffs, badge snippet
├── badge/<id>.svg          the badge
├── feed/<id>.xml           per server RSS
├── api/servers.json        machine readable index
├── log.ndjson              the full log
└── head.json               the signed head
```

Everything on these pages is attacker controlled text, so everything is escaped and the CSP is `default-src 'none'`.

## Why zero dependencies

Two reasons, one practical and one rhetorical.

Practical: a hash comparison tool has no honest need for a dependency tree, and Node 20's standard library covers HTTP, crypto, and streams.

Rhetorical: this project's argument is that supply chain trust decays. Making that argument on top of two hundred transitive packages would be self refuting.

## Deliberate non goals

- **No content analysis.** It does not judge whether a change is dangerous, only that it happened. The moment a model judges, the check stops being deterministic.
- **No blocking by policy at the log level.** The log records, it does not rule.
- **No telemetry.** The proxy makes no network calls unless you opt in to submitting observations.
