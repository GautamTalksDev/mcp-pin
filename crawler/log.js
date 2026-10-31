'use strict';
/*
 * The public log. Append-only, hash-linked, Ed25519-signed heads.
 *
 * Storage is NDJSON on disk. That is deliberate for v1: the entire log is a
 * set of files anyone can download and verify offline with `mcp-pin verify-log`.
 *
 * The log is one hash chain stored as ordered segments: sealed segments in
 * log-segments/0001.ndjson, 0002.ndjson, ... then the active log.ndjson, which
 * is the tail. GitHub rejects any file over 100 MiB, and the single file reached
 * 102.5 MiB on 31 Oct 2026, so the daily "crawl" push was refused. A segment is
 * sealed (renamed, never rewritten) once the active file passes ROTATE_BYTES.
 * The entry shape, the chain and the head signature are unchanged: the head
 * still covers every entry, in segment order.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sha256, canonicalize } = require('../src/canonical');

function parsePublicKeyFile(text) {
  const m = String(text).match(/^[A-Za-z0-9+/=]{40,}$/m);
  if (!m) throw new Error('PUBLIC_KEY.txt contains no key');
  return m[0];
}

function pubFromPrivateB64(b64) {
  const der = Buffer.from(b64, 'base64');
  const priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).toString('base64');
}

// Rotate before an append once the active file is this big. The largest entry
// seen is about 3 MB, so a segment stays far below GitHub's 100 MiB limit.
const ROTATE_BYTES = 50 * 1024 * 1024;
const SEGMENT_DIR = 'log-segments';
const SEGMENT_RE = /^(\d{4})\.ndjson$/;

class PublicLog {
  constructor(dir, opts) {
    this.dir = dir;
    this.rotateBytes = (opts && opts.rotateBytes) || ROTATE_BYTES;
    this.file = path.join(dir, 'log.ndjson');
    this.segmentDir = path.join(dir, SEGMENT_DIR);
    this.headFile = path.join(dir, 'head.json');
    this.keyFile = path.join(dir, 'log-key.json');
    fs.mkdirSync(dir, { recursive: true });
  }

  // Ed25519 keypair. Public key is committed to the repo; private key is a
  // deployment secret. Anyone can verify a head without trusting the server.
  keys() {
    // In CI the key arrives as a base64 secret. Never generate one there:
    // a fresh key every run would mean every day's head was signed by a
    // different identity, which defeats the point of signing at all.
    if (process.env.LOG_PRIVATE_KEY) {
      const der = Buffer.from(process.env.LOG_PRIVATE_KEY, 'base64');
      const priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
      const pub = crypto.createPublicKey(priv);
      return { priv, pubB64: pub.export({ format: 'der', type: 'spki' }).toString('base64') };
    }
    if (fs.existsSync(this.keyFile)) {
      const j = JSON.parse(fs.readFileSync(this.keyFile, 'utf8'));
      return {
        priv: crypto.createPrivateKey({ key: Buffer.from(j.priv, 'base64'), format: 'der', type: 'pkcs8' }),
        pubB64: j.pub,
      };
    }
    if (process.env.CI) throw new Error('LOG_PRIVATE_KEY is not set; refusing to mint a new signing key in CI');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const j = {
      priv: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    };
    fs.writeFileSync(this.keyFile, JSON.stringify(j, null, 2), { mode: 0o600 });
    return { priv: privateKey, pubB64: j.pub };
  }

  // Sealed segments in order, as absolute paths. A gap in the numbering is an
  // error: a missing segment must never read as a shorter, valid log.
  segmentFiles() {
    let names;
    try {
      names = fs.readdirSync(this.segmentDir);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const nums = names.filter((n) => SEGMENT_RE.test(n)).sort();
    nums.forEach((n, i) => {
      if (Number(n.slice(0, 4)) !== i + 1) {
        throw new Error(`log segment ${String(i + 1).padStart(4, '0')}.ndjson is missing`);
      }
    });
    return nums.map((n) => path.join(this.segmentDir, n));
  }

  entries() {
    const out = [];
    const files = this.segmentFiles();
    files.push(this.file);
    for (const f of files) {
      let raw;
      try {
        raw = fs.readFileSync(f, 'utf8');
      } catch (e) {
        if (e.code === 'ENOENT' && f === this.file) continue;
        throw e;
      }
      if (!raw.trim()) continue;
      const where = f === this.file ? '' : ` of ${SEGMENT_DIR}/${path.basename(f)}`;
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (!l.trim()) continue;
        try {
          out.push(JSON.parse(l));
        } catch (e) {
          const err = new Error('malformed log at line ' + (i + 1) + where);
          err.cause = e;
          throw err;
        }
      }
    }
    return out;
  }

  // Seal the active file as the next segment. Content is never changed: the
  // file is renamed, and the next append starts a new active file whose first
  // entry links to the last entry of the sealed one.
  rotate() {
    const next = this.segmentFiles().length + 1;
    fs.mkdirSync(this.segmentDir, { recursive: true });
    fs.renameSync(this.file, path.join(this.segmentDir, String(next).padStart(4, '0') + '.ndjson'));
  }

  lastHash() {
    const e = this.entries();
    return e.length ? e[e.length - 1].entry_hash : 'GENESIS';
  }

  // Append an observation. Returns null if the toolset is byte-identical to
  // the last recorded state for this server. The log records *changes*, plus
  // a liveness timestamp kept separately.
  append(record) {
    try {
      if (fs.statSync(this.file).size >= this.rotateBytes) this.rotate();
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const prev = this.lastHash();
    const body = {
      seq: this.entries().length,
      prev_entry_hash: prev,
      observed_at: new Date().toISOString(),
      server_id: record.server_id,
      server_name: record.server_name,
      source: record.source,
      set_hash: record.set_hash,
      tools: record.tools,
    };
    // The conditions the listing was taken under: env keys supplied and
    // placeholders, never values. Up to 5 October 2026 this field was dropped.
    if (record.probe_env !== undefined) body.probe_env = record.probe_env;
    body.entry_hash = sha256(canonicalize(body));
    fs.appendFileSync(this.file, JSON.stringify(body) + '\n');
    return body;
  }

  // Latest recorded state per server.
  latest() {
    const map = new Map();
    for (const e of this.entries()) map.set(e.server_id, e);
    return map;
  }

  history(serverId) {
    return this.entries().filter((e) => e.server_id === serverId);
  }

  resolveTrustedKey(explicit) {
    if (explicit) return explicit;
    try {
      return parsePublicKeyFile(fs.readFileSync(path.join(this.dir, 'PUBLIC_KEY.txt'), 'utf8'));
    } catch {}
    if (process.env.LOG_PRIVATE_KEY) {
      try { return pubFromPrivateB64(process.env.LOG_PRIVATE_KEY); } catch {}
    }
    return null;
  }

  // Sign the current head. Publish daily.
  signHead() {
    const { priv, pubB64 } = this.keys();
    const entries = this.entries();
    const head = {
      tree_size: entries.length,
      root_hash: this.lastHash(),
      signed_at: new Date().toISOString(),
    };
    const sig = crypto.sign(null, Buffer.from(canonicalize(head)), priv);
    const signed = Object.assign({}, head, { signature: sig.toString('base64'), public_key: pubB64 });
    fs.writeFileSync(this.headFile, JSON.stringify(signed, null, 2));
    return signed;
  }

  // Full offline verification: chain links, entry hashes, and head signature.
  // The trusted key is pinned by the caller (or PUBLIC_KEY.txt / LOG_PRIVATE_KEY).
  // The public_key field on the head is compared against that pin; it is never
  // trusted on its own — otherwise anyone could re-sign a forged log.
  verify(opts) {
    const trusted = this.resolveTrustedKey(opts && opts.trustedPublicKey);
    if (!trusted) return { ok: false, reason: 'no trusted public key' };

    let entries;
    try {
      entries = this.entries();
    } catch (e) {
      return { ok: false, reason: e.message || 'malformed log' };
    }

    let prev = 'GENESIS';
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.prev_entry_hash !== prev) return { ok: false, reason: `broken link at ${i}` };
      const copy = Object.assign({}, e);
      delete copy.entry_hash;
      if (sha256(canonicalize(copy)) !== e.entry_hash) return { ok: false, reason: `bad hash at ${i}` };
      prev = e.entry_hash;
    }

    if (!fs.existsSync(this.headFile)) return { ok: false, reason: 'missing head' };

    let h;
    try {
      h = JSON.parse(fs.readFileSync(this.headFile, 'utf8'));
    } catch (e) {
      return { ok: false, reason: 'malformed head' };
    }
    if (!h || typeof h !== 'object' || !h.signature) return { ok: false, reason: 'malformed head' };
    if (h.public_key !== trusted) return { ok: false, reason: 'head signed by untrusted key' };
    if (h.tree_size !== entries.length) return { ok: false, reason: 'tree_size does not match log' };

    const { signature, public_key, ...body } = h;
    let pub;
    try {
      pub = crypto.createPublicKey({ key: Buffer.from(trusted, 'base64'), format: 'der', type: 'spki' });
    } catch (e) {
      return { ok: false, reason: 'unreadable trusted public key' };
    }
    const ok = crypto.verify(null, Buffer.from(canonicalize(body)), pub, Buffer.from(signature, 'base64'));
    if (!ok) return { ok: false, reason: 'head signature invalid' };
    if (h.root_hash !== prev) return { ok: false, reason: 'head does not match log tip' };
    return { ok: true, count: entries.length };
  }
}

module.exports = { PublicLog, parsePublicKeyFile, ROTATE_BYTES, SEGMENT_DIR };
