# Changelog

## Unreleased

### A server could show the check one toolset and the client another

Up to 0.1.4 the proxy verified the toolset with its own `tools/list` request at connect and then forwarded everything unchecked. Its requests carried recognisable ids (`mcp-pin-<pid>-<n>`), so a server could answer them with the approved tools and answer the client's own `tools/list` with different ones. The same gap let a server change its tools mid-session, after the check, which is how the Deadbugz campaign (Pillar Security, August 2026) behaves. Every `tools/list`, `prompts/list` and `server/discover` response the client asked for is now checked against the pin before it is delivered, for the whole session. A changed or added definition is never forwarded; the session is blocked.

### On Windows, a server started through npx could not start at all

Node cannot start a `.cmd` shim such as `npx` without a shell, so up to 0.1.4 the proxy failed on Windows with `spawn npx ENOENT` for every server launched through npx, which is most of them. Only `.exe` commands such as `node` worked. The proxy now finds the command on `PATH` and runs a shim through `cmd.exe` with every argument escaped, the approach of cross-spawn, which the official MCP TypeScript SDK uses to start stdio servers. The test suite runs on Windows; it passed on Windows 11 with Node 24.

### Three ways server text could get past the check or the review

- A checked response could repeat a JSON member name (two `description` members in one tool, say). The check reads it with `JSON.parse`, which keeps the last copy; some parsers keep the first, and the proxy forwarded the server's original bytes, so such a client could read text the check never saw. A repeated member name in any response mcp-pin checks (the client's listings, the initialize and discover answers that carry the instructions, and mcp-pin's own requests) now stops the session; nothing is forwarded or pinned.
- Tool names and the server's instructions were printed to the terminal as sent, so escape codes could erase or rewrite the lines around them during review, and descriptions kept bidirectional and invisible characters that can disguise a line. All server text in mcp-pin's output now shows control, bidirectional and invisible characters as `\u{...}`. Terminal escape codes, C1 controls, bidi isolates and variation selectors in a change are also labelled `Hidden or unusual characters`.
- When a server answered mcp-pin's own check with an error, the error's text was repeated in the message to the client, which may show it to the model, and a looping page cursor was quoted the same way. Neither is repeated now.

### A correction to 0.1.3

0.1.3 said every listing records the environment it was probed under. The crawler worked it out, but the public log's `append` kept a fixed list of fields and dropped it, and the test only checked that the crawler passed it. None of the first 454 entries, up to 5 October 2026, has it. New entries carry `probe_env` (environment variable names supplied and placeholders used, never values), the published `verify-log` accepts them, and the test now reads the field back from a real log.

### Also in this release

- The hashing recipe is now an open spec, [the tool definition hash](docs/TOOL_DEFINITION_HASH.md), version 1, with test vectors that include the RFC 8785 examples and a second implementation in Python using only the standard library. The two agree on every vector and on 20,000 random values. Two edge cases are now fixed by the spec: definitions that share a name are ordered by hash, not by the order the server sent them, and a listing with a definition that has no string name is refused instead of hashed.
- A monthly drift report (`npm run report:month`), counted from the signed log and published at `/reports/` on the 1st of each month: servers that changed their definitions, the kinds of change as totals, and per server only tool counts. It states gaps in the crawl and dates a change first seen after a gap by the window it happened in. Each crawl run is now kept in `data/crawls.ndjson`, so a report can say which days were looked at. The first report, September 2026: 22 of 254 servers changed their tool definitions in the first four days of crawling.
- The site's own copy no longer uses dashes as punctuation.
- Package pinning in the lock. Definitions can stay the same while the code behind them changes (postmark-mcp 1.0.16, September 2025). `mcp-pin lock` records the exact npm or PyPI version each server runs and the registry's digest of it, or a Docker image digest, and probes exactly that version. With the lock, the proxy runs the locked version even when the config asks for the newest, and refuses a config that names another. `lock --check` fails when the registry serves different contents for the locked version and notes, without failing, when a newer one is out. `mcp-pin wrap` points out servers whose package is not pinned. Understood: npx, npm exec, pnpm dlx, yarn dlx, bunx, uvx and pipx run --spec.
- A team lockfile. `mcp-pin lock` starts each local server in the project's `.mcp.json`, reads its tools, prompts and instructions without calling anything, and writes `mcp-pin.lock` with every definition as readable JSON, so a pull request that updates it shows what a server now tells the model. `mcp-pin wrap --project --lock mcp-pin.lock` points each teammate's proxy at it: a server that differs from the lock is blocked on every machine, on the first run too. A missing, unreadable or hand-edited lock (one that no longer matches its own hashes) stops the server instead of falling back. `mcp-pin lock --check` exits 1 in CI on any change, with labels, including a command edited in `.mcp.json` without re-locking. `${VAR}`, `${VAR:-default}` and `${env:VAR}` in the config are filled in from the environment.
- MCP 2026-07-28. A client that opens with `server/discover` or any request carrying `_meta` protocol fields is verified with its own metadata, and a legacy server's answer to the `server/discover` probe reaches the client at once, so a dual-era client falls back to `initialize` without waiting out a timeout. Before this, such a client was held until it gave up, and a server that spoke only 2026-07-28 could not be verified at all.
- Prompts and the server's instructions to the model are pinned with the tools. Pins made by 0.1.4 and earlier gain them on the next connect where nothing else changed.
- A blocked session answers every request the client is waiting on with a JSON-RPC error (code `-31042`) that names the server and the review command, instead of exiting silently. The error never repeats the changed text.
- `mcp-pin review <id>` prints what changed since you approved a server.
- Every change is labelled above its diff: new tool or prompt, new field or argument, a new instruction to the model, mentions of secrets or private files, a new link or address, hidden or unusual characters, a flipped permission hint (`readOnlyHint` and friends, which clients use to auto-approve), or wording only. Fixed rules over the two versions, counting what the new one adds anywhere in the definition, including parameter descriptions. Labels never unblock anything. The client's error carries the label keys, never the text.
- `mcp-pin wrap` puts the proxy in front of every local MCP server configured in Claude Desktop, Claude Code (user and project scopes in `~/.claude.json`), Cursor, VS Code, Gemini CLI, Devin Desktop, Windsurf, Cline and Codex (`config.toml`). It shows the plan, asks before writing (or takes `--yes`), backs each file up to `~/.mcp-pin/backups`, skips remote servers and entries that are already wrapped, and pins an exact mcp-pin version in every entry. `mcp-pin unwrap` reverses it. Pins are keyed by the original command, so wrapping keeps them.
- When the client closes stdin, the proxy closes the server's stdin, so both exit cleanly.
- A Claude Code plugin and marketplace in this repository (`claude plugin marketplace add GautamTalksDev/mcp-pin`): the lookup tools, an Agent Skill for checking servers and explaining blocks, and a SessionStart note listing local servers that run without mcp-pin. The skill also works in agents that read `.agents/skills/`.
- An install page on the site (`/install/`): one command for every app, *Add to Cursor* and *Add to VS Code* links, and a generator that protects any server command for each app and gives server authors an install link for their README. The site's Install link points there.
- `mcp-pin lookup`: mcp-pin as an MCP server with four read-only tools. `mcp_pin_server_status` reads the public log; `mcp_pin_my_servers` and `mcp_pin_change_summary` read the local pins; `mcp_pin_how_to_protect` gives setup steps. None returns third-party text. Both protocol generations. `--http <port>` serves the public tools only, on 127.0.0.1.

## 0.1.4

- `mcp-pin demo`. The whole failure in about ten seconds with nothing to configure. A harmless bundled server (`demo/drift-server.js`) changes its one tool between two sessions: the description starts asking for notes from the conversation and the schema grows a field to carry them. The first session pins; the second is blocked with the diff. It runs in a temporary folder that is deleted afterwards, never reads or writes your real pins, never calls a tool, and makes no network calls. The older `demo/rugpull-server.js` stays a test fixture and is not in the package.
- The public log's daily crawl is back on. It was paused from 4 September to 5 October 2026. Badges now stop counting at the last good look: after more than three days without one they read `last checked <date>`, not a number that kept growing while nobody looked. A change first seen after a gap reads `changed since <date>`, not `changed today`, and is not counted as a change in the last 24 hours. Site pages use the same rules as the badge.
- Install commands on the site follow the package version.

## 0.1.3

Published 5 September 2026. It adds the crawler changes of 4 September: every listing records the environment it was probed under, placeholders only reach credential-shaped variables, and the recrawl findings are disclosed on the site. `mcp-pin verify` now tells an absent log from a verified empty one. How the proxy pins and blocks did not change.

## 0.1.2

0.1.1 was tagged and then withdrawn; it never landed on npm. Two store bugs survived the concurrent-pin rewrite.

- Log lock: `openSync(..., 'wx')` contention is `EPERM` / `EACCES` / `EBUSY` on Windows, not only `EEXIST`. Work also ran inside the contention `catch`, so an append failure could be retried or reported as a lock error.
- First pin and approve wrote the pin file before the log entry. A failed append left a trusted pin with no public record (16 pin files, 15 log lines on windows/node20). The log entry is now the commitment; the pin is written after it succeeds.

## 0.1.1

Three P0 defects in 0.1.0 were confirmed against the published package. They are the reason this release exists.

### Silent success, which is the failure class this tool exists to catch

`mcp-pin@0.1.0` unlocked a read-modify-write on a single `pins.json`. One hundred concurrent pins of one hundred distinct servers each *reported* success. `log.ndjson` recorded 100 entries with 100 unique `server_id`s. `pins.json` retained 12 keys. Eighty-eight writes vanished. The hash chain also broke five times, because log appends were equally unserialized.

A pin that reports success while discarding the pin is the same class of bug the proxy was built to catch in other people's servers: a change that happens, a signal that does not.

0.1.1 stores each pin at `pins.d/<server_id>.json`, written to a temp file, fsynced, and renamed into place. Log appends take an exclusive lock, read the tail, append, fsync, and unlock. Concurrent distinct servers no longer collide, and the chain cannot be written by two processes at once.

### Pagination was truncated, in the proxy and in the crawler

`tools/list` pagination (`nextCursor`) was ignored. A server that returned page 1 with `nextCursor: 'p2'` and a second tool on page 2 was fingerprinted as page 1 only. The crawler had the identical bug, so the public log's tool counts are a floor, not a count, for any paginated server. A truncated server's page-2 tools can change forever while a badge still says `unchanged 91 days`.

0.1.1 collects pages until there is no `nextCursor`, caps at 50, breaks cursor loops, and fingerprints the concatenation sorted by tool name. The same helper is used by the proxy and the crawler. History for any server whose tool count jumps on the next crawl was incomplete and must not be used for outreach until that crawl.

### Corrupt state was fail-open

A truncated `pins.json` or a garbage `log.ndjson` was treated as "no pins yet" / "OK, 0 entries". Corruption is now a hard error naming the file. `ENOENT` remains the only tolerated miss (a genuine first run).

### Client traffic is held until verification completes

0.1.0 forwarded `initialize` immediately and probed `tools/list` in parallel. A client could call a tool while that probe was still running; the side effect completed before the block message printed. 0.1.1 queues inbound client messages from the start, withholds the initialize response until the complete toolset matches the pin, and on drift discards the queue. Nothing queued is forwarded.

### Also in this release

- Home directory is created mode 0700, pin and log files 0600.
- Raw command argv is no longer stored or printed. It frequently contains API keys. Pins and log entries keep the server id hash and a redacted display form (command basename plus argument count).
- The scheduled crawl is disabled. Crawl and sign are separate jobs; `sign` has `needs: crawl` and `if: success()`, so a failed crawl never sees the key. The 4 September 2026 scheduled run still used `if: always()` in one job and signed a partial crawl (`52d6ac1`, 18 entries, `last-crawl.json` stale). That head was not rewritten. Note: `data/incomplete-crawl-2026-09-04.json`.
- `PUBLIC_KEY.txt` is published at the site root. `verify-log` pins that key and will not accept a head signed by whatever key arrives with the file. A missing head, a mismatched `tree_size`, and a malformed log all fail.
- On 4 September 2026 every recorded server was re-probed with pagination. **18 of 248 had a higher tool count; 0 of those 18 currently return `nextCursor`.** The jumps are package drift, not recovered pages. The note is `data/pagination-recrawl.json` and the about page. A signed log that quietly corrected itself would be worse than one that did not need correcting; publishing this is the correction.
- Claims are narrowed to what the code does. mcp-pin detects when tool definitions change between sessions, including changes the server did not announce. It does not protect against a malicious program running as the same user (that program can delete `~/.mcp-pin` and re-pin itself). The GitHub Action is marked experimental and is not part of this release.

## 0.1.0

Initial release. The defects above are in this version. Do not use it.
