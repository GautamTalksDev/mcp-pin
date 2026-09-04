# Contributing

Small project, one maintainer, university term in progress. Realistic expectations beat generous promises.

## Fastest ways to help

1. **Run it against a real server and tell me what broke.** Coverage is currently around 38% of npm discovered candidates. Every failure reason is useful signal.
2. **Report a false positive.** If mcp-pin flags a change that is not a real change, that is the worst possible bug for a security tool. Trust dies at the first false alarm.
3. **Test another client.** stdio is exercised against Claude Desktop. Cursor, Cline, Codex, and OpenCode need someone with them installed.
4. **Documentation that would have saved you time.**

## Before opening a pull request

```bash
node test/run.js     # all tests must pass
```

- No new runtime dependencies. This is a hard rule, not a preference. If something genuinely cannot be done with the standard library, open an issue and make the case first.
- New behaviour needs a test. Security relevant behaviour needs a test that fails without the fix.
- Match the existing style. Comments explain *why*, not *what*.

## Commit and PR style

Present tense, specific: `crawler: reject toolsets over the byte cap` rather than `fix bug`.

In the PR, say what breaks if the change is wrong. Reviewing a security tool is mostly about understanding failure modes.

## What will be declined

- Anything putting a model in the trust path. An optional local summariser explaining a diff in English is fine and must be labelled non authoritative. A model deciding whether to block is not.
- Telemetry, analytics, or any default network call from the proxy.
- Scope expansion into scanning, sandboxing, or policy enforcement. This project hashes and compares. That narrowness is the product.
- Speculative abstraction for use cases nobody has yet.

## Security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Opting your server out of the log

Add it to `OPTOUT.txt` or open an issue titled `opt out: <name>`. Honoured on the next crawl, no justification required. You do not need to explain yourself and you will not be asked to.
