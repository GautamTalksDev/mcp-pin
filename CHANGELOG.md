# Changelog

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
- The scheduled crawl is disabled until a pagination-complete re-crawl. Crawling and signing run on separate jobs; the crawl job checks out with `persist-credentials: false` and never sees the signing key.
- `PUBLIC_KEY.txt` is published at the site root. `verify-log` pins that key and will not accept a head signed by whatever key arrives with the file. A missing head, a mismatched `tree_size`, and a malformed log all fail.
- On 4 September 2026 every recorded server was re-probed with pagination. **18 of 248 had a higher tool count; 0 of those 18 currently return `nextCursor`.** The jumps are package drift, not recovered pages. The note is `data/pagination-recrawl.json` and the about page. A signed log that quietly corrected itself would be worse than one that did not need correcting; publishing this is the correction.
- Claims are narrowed to what the code does. mcp-pin detects when tool definitions change between sessions, including changes the server did not announce. It does not protect against a malicious program running as the same user (that program can delete `~/.mcp-pin` and re-pin itself). The GitHub Action is marked experimental and is not part of this release.

## 0.1.0

Initial release. The defects above are in this version. Do not use it.
