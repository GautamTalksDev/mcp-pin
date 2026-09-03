# 17 MCP tool definitions changed without changing a word

*3 September 2026. Data: [mcp-pin.gautamkhosla.com](https://mcp-pin.gautamkhosla.com), raw log at [log.ndjson](https://mcp-pin.gautamkhosla.com/log.ndjson).*

I crawled 248 public MCP servers twice in one day and recorded a fingerprint of every tool's full metadata: name, description, input schema, annotations, canonicalized per RFC 8785 and hashed with SHA-256.

Fourteen servers changed between the two runs. That part is unremarkable. People ship.

What is worth looking at is **how** they changed.

| | count |
|---|---|
| Descriptions rewritten | 54 |
| **Schema or annotations changed, description byte-identical** | **17** |
| Tools added | 9 |
| Tools removed | 7 |

Seventeen tool definitions changed while their description text stayed exactly the same, to the byte. Same characters, same length, different fingerprint. The change is entirely in the input schema or the annotations.

## Why that matters

A model does not read a tool description as documentation. It reads it, and the schema next to it, as the specification for what the tool is and when to reach for it. Both are in context. Both steer behaviour.

But only one of them is what a human checks.

If you are reviewing a release, you read the description diff. If you are a user deciding whether to trust a server, you read the description. A changed `enum`, a new optional parameter, a flipped `readOnlyHint` — those sit outside the text and are easy to miss, and they still change what the model does.

And no MCP client re-prompts. Approval happens once. Nothing re-derives it.

## Where the 17 were

| Server | Schema-only | Text | Added | Removed | Tools |
|---|---|---|---|---|---|
| `@ironbee-ai/devtools` | 9 | 3 | 0 | 6 | 51 |
| `context-mode` | 3 | 8 | 0 | 0 | 11 |
| `notion-mcp-server` | 2 | 0 | 0 | 0 | 3 |
| `comfyui-mcp` | 1 | 0 | 0 | 0 | 41 |
| `hostinger-api-mcp` | 1 | 0 | 3 | 0 | 375 |
| `dataforseo-mcp-server` | 1 | 0 | 0 | 0 | 4 |

Nothing here is an accusation. Every one of these is a normal release by people doing normal work. `context-mode` in particular was cutting description bloat, `ctx_search` from 3,351 characters to 442, which is a good change. The point is not that anyone did something wrong. The point is that a class of change is happening routinely and is not visible where people look.

`comfyui-mcp` did it twice in two days, on different tools.

## Two caveats, because the numbers deserve them

**`@nordsym/apiclaw` is excluded from the 54.** All 14 of its tools changed between runs, but not because of a release: its descriptions embed a per-session auth URL that rotates. Same length, different token, every connect. That is a separate finding, [reported to them](https://github.com/nordsym/apiclaw/issues/40), and counting it as drift would inflate the headline.

**Two runs is not a trend.** This is one day of data against 248 servers. It says a thing happens; it does not yet say how often. The log keeps running daily and the history is public, so anyone can check whether the pattern holds.

## Catching it

The fix is not clever. Hash the whole metadata surface, compare it to what you shipped last time, and look at what moved.

In CI, that is one workflow file:

```yaml
- uses: GautamTalksDev/mcp-pin@v1
  with:
    command: node
    args: dist/index.js
```

First run writes a baseline into your repo. After that, any pull request that moves a tool definition gets a comment with the diff, and the schema-only cases are called out first. The baseline is a file you own; nothing is sent anywhere.

There is also a local proxy that pins definitions at approval time and blocks a session when they change, and the public log that produced these numbers.

All of it is [MIT and dependency-free](https://github.com/GautamTalksDev/mcp-pin). The log is hash-linked and signed, so you can download it and verify these numbers without trusting me.

If you maintain a server here and would rather not be crawled, [say so](https://mcp-pin.gautamkhosla.com/about.html) and it stops.
