#!/usr/bin/env node
'use strict';
/*
 * mcp-pin crawler.
 *
 * node crawler/crawl.js [--limit N] [--allow-exec] [--data DIR] [--concurrency N]
 *
 * Records an entry only when a server's toolset hash differs from its last
 * recorded state. Liveness (last seen, last probe result) is tracked
 * separately in state.json so the log stays a change log, not a heartbeat log.
 */
const fs = require('fs');
const path = require('path');
const { discover } = require('./discover');
const { probe } = require('./probe');
const { PublicLog } = require('./log');
const os = require('os');

// Opt out. Anyone who does not want their server crawled adds its name to
// OPTOUT.txt (one per line, '#' comments) and we never probe it again.
// Honoured before discovery results are used, so an opt-out is immediate.
function loadOptOut() {
  const out = new Set();
  for (const f of ['OPTOUT.txt', path.join(__dirname, '..', 'OPTOUT.txt')]) {
    try {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        const v = line.split('#')[0].trim().toLowerCase();
        if (v) out.add(v);
      }
    } catch {}
  }
  return out;
}

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const has = (n) => args.indexOf(n) !== -1;

const DATA = path.resolve(flag('--data', 'data'));
const LIMIT = parseInt(flag('--limit', '0'), 10) || 0;
const CONC = parseInt(flag('--concurrency', '8'), 10);
const ALLOW_EXEC = has('--allow-exec');
const SCRATCH = path.resolve(flag('--scratch', path.join(os.tmpdir(), 'mcp-pin-scratch')));

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    })
  );
  return out;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8')); } catch { return { servers: {} }; }
}

function saveState(s) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify(s, null, 2));
}

(async () => {
  const started = Date.now();
  fs.mkdirSync(DATA, { recursive: true });
  const log = new PublicLog(DATA);
  const state = loadState();

  process.stderr.write('discovering...\n');
  let servers = await discover({ limit: 250, github: !!process.env.GITHUB_TOKEN });
  const optout = loadOptOut();
  if (optout.size) {
    const before = servers.length;
    servers = servers.filter((s) => !optout.has(String(s.name).toLowerCase()));
    process.stderr.write(`honouring ${before - servers.length} opt-out entries\n`);
  }
  if (LIMIT) servers = servers.slice(0, LIMIT);
  process.stderr.write(`discovered ${servers.length} candidate servers\n`);

  if (!ALLOW_EXEC) {
    const before = servers.length;
    servers = servers.filter((s) => s.install && s.install.type === 'http');
    process.stderr.write(`--allow-exec not set: probing ${servers.length} http servers, skipping ${before - servers.length} stdio\n`);
  }

  let changed = 0, newly = 0, failed = 0;
  const DELAY_MS = parseInt(flag('--delay-ms', '250'), 10);
  const results = await pool(servers, CONC, async (s, idx) => {
    if (DELAY_MS) await new Promise((res) => setTimeout(res, (idx % CONC) * DELAY_MS));
    const r = await probe(s, { allowExec: ALLOW_EXEC, scratch: SCRATCH, timeoutMs: 30000 });
    const prev = state.servers[s.id];
    const now = new Date().toISOString();

    if (!r.ok) {
      failed++;
      state.servers[s.id] = Object.assign({}, prev, {
        id: s.id, name: s.name, source: s.source, description: s.description, homepage: s.homepage,
        last_probe_at: now, last_error: r.error,
      });
      return { id: s.id, ok: false };
    }

    const isNew = !prev || !prev.set_hash;
    const drifted = prev && prev.set_hash && prev.set_hash !== r.setHash;

    if (isNew || drifted) {
      log.append({
        server_id: s.id, server_name: s.name, source: s.source,
        set_hash: r.setHash,
        tools: r.tools.map((t) => ({ name: t.name, hash: t.hash, canonical_json: t.canonical })),
      });
      if (isNew) newly++; else changed++;
    }

    state.servers[s.id] = {
      id: s.id, name: s.name, source: s.source, description: s.description, homepage: s.homepage,
      set_hash: r.setHash, tool_count: r.count,
      first_seen_at: (prev && prev.first_seen_at) || now,
      last_probe_at: now,
      last_change_at: drifted ? now : (prev && prev.last_change_at) || null,
      last_error: null,
    };
    return { id: s.id, ok: true, drifted };
  });

  saveState(state);
  let treeSize;
  try {
    treeSize = log.entries().length;
  } catch (e) {
    process.stderr.write('log unreadable after crawl: ' + e.message + '\n');
    process.exit(1);
  }

  // Signing happens on a separate runner that never executes crawled packages.
  // Local crawls still sign if a key is present.
  const hasKey = !!(process.env.LOG_PRIVATE_KEY || fs.existsSync(path.join(DATA, 'log-key.json')));
  let head = { tree_size: treeSize };
  let verified = false;
  if (hasKey) {
    head = log.signHead();
    const v = log.verify();
    verified = v.ok;
    if (!v.ok) process.stderr.write('verify failed after signing: ' + v.reason + '\n');
  } else {
    process.stderr.write('no signing key present; leaving the head unsigned (sign job must sign)\n');
  }

  const summary = {
    ran_at: new Date().toISOString(),
    duration_s: Math.round((Date.now() - started) / 1000),
    candidates: servers.length,
    probed_ok: results.filter((r) => r && r.ok).length,
    failed,
    newly_recorded: newly,
    changed,
    log_size: head.tree_size,
    log_verified: verified,
  };
  fs.writeFileSync(path.join(DATA, 'last-crawl.json'), JSON.stringify(summary, null, 2));
  process.stderr.write(JSON.stringify(summary, null, 2) + '\n');

  // Probed servers are untrusted third-party processes. Some of them leave
  // handles open (timers, sockets, orphaned children) which keeps Node alive
  // long after the crawl is done. On CI that means the job hits its timeout
  // and the log is never committed, which is worse than a failed crawl.
  // The work is finished and flushed at this point, so exit deliberately.
  process.exit(0);
})();
