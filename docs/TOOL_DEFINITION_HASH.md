# Tool definition hash, version 1

**Status:** draft for discussion, 5 October 2026. Open to anyone to implement, under the repository's MIT license.
**Implementations:** mcp-pin (JavaScript, [`src/canonical.js`](../src/canonical.js)) and an independent reference in Python using only the standard library ([`tool_definition_hash.py`](tool_definition_hash.py)). Both pass every [test vector](tool-definition-hash-vectors.json), and they agree on 20,000 randomly generated values.

## Why

Clients, proxies, registries, scanners and lockfiles all fingerprint MCP tool definitions so they can notice when a server changes what it tells the model after someone approved it. Today each computes its fingerprint its own way, so none of them can check another's. A hash a registry publishes cannot be verified by a client, and a lock written by one tool cannot be enforced by another.

This document fixes one recipe, with test vectors, so that independent implementations get the same hash for the same definitions. It covers what the model reads from a server before any tool runs: tool definitions, prompt definitions, and the server's instructions.

## Terms

- A **definition** is one object from the `tools` array of a `tools/list` result, or from the `prompts` array of a `prompts/list` result, exactly as the server sent it.
- A **listing** is every definition of one kind the server returns, across all pages.
- **SHA-256** is from FIPS 180-4. Every hash in this document is written as 64 lowercase hexadecimal characters.
- **UTF-8** encoding of a string follows the WHATWG Encoding Standard: an unpaired surrogate is encoded as U+FFFD.
- MUST, SHOULD and MAY are used as in RFC 2119.

## 1. Canonical form of a definition

The canonical form of a definition is its serialization under the JSON Canonicalization Scheme, [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785), encoded as UTF-8. In brief:

- Object members are sorted by name, comparing UTF-16 code units, at every depth.
- There is no whitespace between tokens.
- In strings, `"` and `\` are escaped. U+0008, U+0009, U+000A, U+000C and U+000D are written `\b`, `\t`, `\n`, `\f` and `\r`. Every other character below U+0020 is written `\u00xx` in lowercase hex. Every other character is written as itself, including `/`, U+2028 and characters outside ASCII.
- Every number is read as an IEEE 754 double and written the way ECMAScript writes it (`Number.prototype.toString`, which is also `JSON.stringify` in JavaScript). So `1.0` is `1`, `4.50` is `4.5`, `1E30` is `1e+30`, `-0` is `0`, and `12345678901234567890` is `12345678901234567000`.

The definition is hashed whole. Every member the server sent is included, including members this document does not name, such as `title`, `icons`, `outputSchema`, `annotations` and `_meta`, and any member added to MCP later. An implementation MUST NOT drop, default or normalize members. The rule is simple: if the server sent it, it is hashed.

Two cases fall outside I-JSON, which RFC 8785 assumes:

- **A repeated member name** in any object of a definition means the definition has no canonical form. Parsers disagree about which copy wins (JavaScript's `JSON.parse` keeps the last, some keep the first), so no single hash can stand for what every reader sees. A verifier MUST treat such a definition as not matching. See [Security considerations](#6-security-considerations).
- **An unpaired surrogate** in a string is written as a lowercase `\u` escape (`\udead`), as ECMAScript's `JSON.stringify` writes it. The result is still deterministic.

## 2. Definition hash

```
definition hash = SHA-256( UTF-8( canonical form ) )
```

## 3. Set hash

The set hash covers a whole listing, so it changes when a definition is added or removed, not only when one changes.

1. Collect the complete listing. Request pages until a result's `nextCursor` is absent or the empty string, and concatenate the definitions.
2. Every definition MUST have a string `name`. A listing with a definition that does not has no set hash, and a verifier MUST treat it as not matching.
3. Compute each definition's hash.
4. Sort the definitions by `name`, comparing UTF-16 code units. Definitions that share a name are ordered by their hashes. The order the server sent them in never matters.
5. Write one line per definition, `name:hash`, and join the lines with a single U+000A, with no newline at the end.
6. The set hash is the SHA-256 of the UTF-8 bytes of that text.

An empty listing hashes the empty string: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

Tools and prompts get separate set hashes, built the same way.

A name may contain any character, including `:` and line breaks, without making two different listings hash alike. Each line's hash covers the definition's canonical form, and that includes its name, so splitting the text differently would need a SHA-256 collision.

## 4. Instructions hash

```
instructions hash = SHA-256( UTF-8( instructions ) )
```

`instructions` is the string the server returns in its `initialize` result (protocol versions up to 2025-11-25) or its `server/discover` result (2026-07-28). It is hashed exactly as received, with no canonicalization or Unicode normalization. A server that sends no `instructions` string has no instructions hash; it is recorded as `null`, which is not a hash of anything.

## 5. What it does not cover

- **What tools do.** Results of `tools/call`, the messages `prompts/get` returns, and resource contents are outputs, not definitions.
- **The server's code.** A package can change behind the same definitions. Pinning the package (an npm version and its integrity hash, an OCI image digest) is a separate check, and both are needed.
- **Who wrote it.** This is a content hash, not a signature. It says the definitions are the same as before, not that anyone vouches for them.
- **Whether the change is safe.** A changed hash means a person should look. A definition that was hostile when it was first approved hashes the same every day.

## 6. Security considerations

**Check what the client receives.** A verifier that requests its own listing and lets the client request another can be shown two different listings: the server answers the verifier's request with the approved definitions and the client's with something else. mcp-pin had this gap up to 0.1.4. A verifier in the message path MUST check the listings the client itself receives, for the whole session, not only at connect. A changed `list_changed` notification, TTL or cache hint does not change this. Every listing the client receives is compared with the approved hashes.

**Forward what you hashed.** A verifier that forwards the server's original bytes MUST reject responses that repeat a member name (section 1). Otherwise the client's parser may read a copy the verifier never hashed.

**Show definitions safely.** When a changed definition is shown to a person for review, control characters, bidirectional controls and invisible characters MUST be displayed as visible escapes. A definition is attacker-controlled text, and terminal escape codes or bidi overrides in it can erase or disguise the very lines a reviewer is reading. Never repeat a changed definition to the model in an error message; that text is the attack.

**Look-alike names are different names.** The hash is over code points as sent, so `weather` and `wеather` (with a Cyrillic `е`) hash differently, as they should. Matching definitions by name across servers is outside this document.

## 7. Test vectors

[`tool-definition-hash-vectors.json`](tool-definition-hash-vectors.json) holds every input as JSON text, so an implementation parses it itself. Number parsing and repeated member names are part of what is tested. It has four sections:

- `definitions`: input, canonical form and hash. Two vectors are the examples from RFC 8785 sections 3.2.2 and 3.2.3, and their canonical forms match the RFC's published output.
- `sets`: one or more pages, the sorted `name:hash` lines, and the set hash.
- `instructions`: a string or `null`, and its hash.
- `invalid`: inputs that have no canonical form or no set hash.

Check them with either implementation:

```bash
python3 docs/tool_definition_hash.py
node test/run.js
```

## 8. Where this fits in MCP

- **Interceptors** ([SEP-2624](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2624), draft). A client-side validator on the response phase of `tools/list` and `prompts/list` can compare every listing with approved set hashes and return `severity: "error"` on a mismatch, which blocks it. SEP-2624 has no event for the `initialize` or `server/discover` result, so the server's instructions, which the model also reads, are not reachable by an interceptor today.
- **Runtime drift.** The MCP Security Interest Group lists "Runtime drift: `list_changed` semantics after approval" as an open discussion item. A shared hash lets a client, a gateway and a registry agree on what "the same definitions as approved" means before agreeing on what to do when they change.
- **Registries and lockfiles.** A registry can publish set hashes next to a server's version, and a project can commit them. [`mcp-pin.lock`](../README.md#for-teams-commit-an-mcp-pinlock) stores the hashes and readable definitions this document describes.

## Changes to this document

A change to any rule in sections 1 to 4 is a new version, with new vectors. Version 1 is what mcp-pin computes from 0.2.0 on. Earlier versions of mcp-pin computed the same definition hashes and set hashes, with two exceptions: definitions sharing a name were left in the order the server sent them, and a definition without a string name was hashed instead of refused.
