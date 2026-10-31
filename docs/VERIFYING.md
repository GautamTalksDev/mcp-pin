# Verifying the log without trusting us

A transparency log is only worth something if you can check it yourself. This page shows how, and is deliberately short enough to actually follow.

## The one command

```bash
git clone --depth 1 https://github.com/GautamTalksDev/mcp-pin.git
npx --yes mcp-pin@0.2.4 verify-log mcp-pin/data
```

```
public log OK, 454 entries, chain intact, head signature valid
```

Non zero exit means something is wrong and you should say so publicly.

## The files

GitHub refuses any file over 100 MiB, and the log passed that on 31 October 2026. Since then it is stored as one hash chain in several files, read in this order:

1. the sealed segments, `data/log-segments/0001.ndjson`, `0002.ndjson` and so on, which never change once sealed;
2. the active `data/log.ndjson`, which is sealed as the next segment once it passes 50 MiB;
3. `data/head.json`, the signed head, which covers every entry in every file.

To verify without cloning, put `head.json`, `log.ndjson` and every segment in one folder, keeping the `log-segments` folder, and run `npx --yes mcp-pin@0.2.4 verify-log .` there. A missing, reordered or malformed segment fails.

Use 0.2.4 or later. Earlier versions read only `log.ndjson`, so they report a broken link at entry 0 on the log as it is stored today.

## What that command actually checks

```mermaid
flowchart LR
    E0["entry 0<br/>prev: GENESIS"] --> E1["entry 1<br/>prev: hash(E0)"] --> E2["entry 2<br/>prev: hash(E1)"] --> H["signed head<br/>root: hash(E2)"]
```

1. **Chain integrity.** Each entry names its predecessor's hash. Editing entry 4 changes its hash, so entry 5's `prev_entry_hash` no longer matches, and so on to the end.
2. **Entry integrity.** Each entry's `entry_hash` is SHA-256 over its own canonicalized content. Changing any field breaks it.
3. **Head signature.** The head is Ed25519 signed. The verifier pins `PUBLIC_KEY.txt` from the package (and from the site root). It will not accept a head signed by whatever key arrives with the file. A missing head, a mismatched `tree_size`, and a malformed log all fail.

Together: you cannot change history without either breaking the chain or forging a signature.

## Doing it by hand

If you would rather not trust our verifier either, that is the correct instinct. Run these in the folder that holds the log files (`mcp-pin/data` after the clone above). Entry 0 is the first line of the first segment.

```bash
# recompute one entry's hash
node -e '
const crypto = require("crypto");
const line = require("fs").readFileSync("log-segments/0001.ndjson","utf8").split("\n")[0];
const e = JSON.parse(line);
const claimed = e.entry_hash;
delete e.entry_hash;
const sorted = (o) => Array.isArray(o) ? o.map(sorted)
  : (o && typeof o === "object")
    ? Object.keys(o).sort().reduce((a,k)=>(a[k]=sorted(o[k]),a),{})
    : o;
const actual = crypto.createHash("sha256").update(JSON.stringify(sorted(e))).digest("hex");
console.log(claimed === actual ? "entry 0 verifies" : "MISMATCH");
'
```

```bash
# verify the head signature
node -e '
const crypto = require("crypto"), fs = require("fs");
const h = JSON.parse(fs.readFileSync("head.json","utf8"));
const { signature, public_key, ...body } = h;
const key = crypto.createPublicKey({ key: Buffer.from(public_key,"base64"), format:"der", type:"spki" });
const sorted = (o) => Array.isArray(o) ? o.map(sorted)
  : (o && typeof o === "object")
    ? Object.keys(o).sort().reduce((a,k)=>(a[k]=sorted(o[k]),a),{})
    : o;
console.log(crypto.verify(null, Buffer.from(JSON.stringify(sorted(body))), key,
  Buffer.from(signature,"base64")) ? "head signature valid" : "INVALID");
'
```

## The second, independent record

Every crawl commits the log to a public git repository. That commit history is a separate append only record maintained by GitHub rather than by this project. Rewriting a log entry would require rewriting git history that other people have already cloned.

Keeping your own copy is the strongest thing you can do. If your copy and the published copy ever disagree, you can prove it.

## What verification does not prove

Being precise here matters more than sounding strong.

- It proves **nobody edited the record**. It does not prove the record is complete. A crawl that never reached a server records nothing about it.
- It does not prove any server is safe. It proves what its definitions were, and when.
- **Split view is not yet ruled out.** A single operator signs today. Certificate Transparency solves this with independent witnesses co-signing heads, and this project has not built that yet. Until it does, comparing your head against someone else's is the practical defence, and it works.
