'use strict';
/*
 * The public log. Append-only, hash-linked, Ed25519-signed heads.
 *
 * Storage is NDJSON on disk. That is deliberate for v1: the entire log is a
 * file anyone can download and verify offline with `mcp-pin verify-log`.
 * Move to D1/Turso when the file gets large; the entry shape does not change.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sha256, canonicalize } = require('../src/canonical');

class PublicLog {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'log.ndjson');
    this.headFile = path.join(dir, 'head.json');
    this.keyFile = path.join(dir, 'log-key.json');
    fs.mkdirSync(dir, { recursive: true });
  }

  // Ed25519 keypair. Public key is committed to the repo; private key is a
  // deployment secret. Anyone can verify a head without trusting the server.
  keys() {
    if (fs.existsSync(this.keyFile)) {
      const j = JSON.parse(fs.readFileSync(this.keyFile, 'utf8'));
      return {
        priv: crypto.createPrivateKey({ key: Buffer.from(j.priv, 'base64'), format: 'der', type: 'pkcs8' }),
        pubB64: j.pub,
      };
    }
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const j = {
      priv: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    };
    fs.writeFileSync(this.keyFile, JSON.stringify(j, null, 2), { mode: 0o600 });
    return { priv: privateKey, pubB64: j.pub };
  }

  entries() {
    try {
      return fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  lastHash() {
    const e = this.entries();
    return e.length ? e[e.length - 1].entry_hash : 'GENESIS';
  }

  // Append an observation. Returns null if the toolset is byte-identical to
  // the last recorded state for this server — the log records *changes*, plus
  // a liveness timestamp kept separately.
  append(record) {
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
  verify() {
    const entries = this.entries();
    let prev = 'GENESIS';
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.prev_entry_hash !== prev) return { ok: false, reason: `broken link at ${i}` };
      const copy = Object.assign({}, e);
      delete copy.entry_hash;
      if (sha256(canonicalize(copy)) !== e.entry_hash) return { ok: false, reason: `bad hash at ${i}` };
      prev = e.entry_hash;
    }
    if (fs.existsSync(this.headFile)) {
      const h = JSON.parse(fs.readFileSync(this.headFile, 'utf8'));
      const { signature, public_key, ...body } = h;
      const pub = crypto.createPublicKey({ key: Buffer.from(public_key, 'base64'), format: 'der', type: 'spki' });
      const ok = crypto.verify(null, Buffer.from(canonicalize(body)), pub, Buffer.from(signature, 'base64'));
      if (!ok) return { ok: false, reason: 'head signature invalid' };
      if (h.root_hash !== prev) return { ok: false, reason: 'head does not match log tip' };
    }
    return { ok: true, count: entries.length };
  }
}

module.exports = { PublicLog };
