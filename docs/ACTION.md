# The GitHub Action

> **Experimental.** This action is not part of the 0.1.1 release. Bootstrap instructions currently reference a package that is not on npm, and the baseline does not survive the runner. Prefer the local proxy (`npx mcp-pin@0.1.1`). Do not adopt this action in CI yet.

Catch changes to your own tool definitions in the pull request that makes them.

```yaml
- uses: GautamTalksDev/mcp-pin@v1
  with:
    command: node
    args: dist/index.js
```

That is the whole setup. First run writes `.mcp-pin/tools.json`; commit it. Every run after that compares against it and comments on the PR when anything moved.

## Why this and not a badge

A badge asks you to advertise someone else's project. This asks nothing: it catches your own regressions, in your own repo, against a baseline you own.

**Nothing is sent anywhere.** The baseline is a file in your repository. The action does not contact mcp-pin.gautamkhosla.com or any other host, and there is a test in the suite that fails if that ever changes.

## What it catches that review does not

Reviewing a diff of your source catches description edits. It does not reliably catch a changed input schema, a flipped annotation, or a reordered enum, because those often live far from the text you are reading.

On 3 September 2026, across 248 crawled servers, **17 tool definitions changed while their descriptions stayed byte-identical.** Real projects, normal releases. The action calls those out first:

> **2 of these changed their schema or annotations while the description stayed byte-identical.**
> Those are invisible in a normal diff of the description text, and they still change what the model does.

## Options

| Input | Default | What it does |
|---|---|---|
| `command` | | Command that starts your server over stdio, e.g. `node` |
| `args` | | Arguments, space separated, e.g. `dist/index.js` |
| `url` | | A streamable HTTP server, instead of command and args |
| `baseline` | `.mcp-pin/tools.json` | Where the committed fingerprint lives |
| `fail-on-change` | `false` | Fail the job rather than only commenting |
| `comment` | `true` | Post or update a comment on the pull request |
| `update-baseline` | `false` | Rewrite the baseline to accept a change |

Outputs: `changed`, `set-hash`, `tool-count`, `schema-only-count`.

## A full workflow

```yaml
name: tool definitions
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  mcp-pin:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci && npm run build
      - uses: GautamTalksDev/mcp-pin@v1
        with:
          command: node
          args: dist/index.js
```

`pull-requests: write` is only needed for the comment. Drop it and set `comment: false` if you would rather have the job summary alone.

## Accepting a change

The comment is informational by default; a normal release will show a diff and that is fine. When you are happy with it, regenerate the baseline and commit:

```bash
INPUT_COMMAND=node INPUT_ARGS=dist/index.js npx mcp-pin-action --update
```

or run the action once with `update-baseline: true`.

## Making it a gate

Set `fail-on-change: true` and the job fails until someone looks at the diff and updates the baseline in the same PR. That turns tool metadata into something reviewed on purpose rather than by accident.

## What it does not do

It does not judge whether a change is dangerous, and there is no model anywhere in it. It reports that bytes differ, with a diff, and leaves the judgement to you. A server that was wrong from its first commit and never changes looks perfectly stable to it.
