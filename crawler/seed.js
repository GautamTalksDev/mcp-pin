#!/usr/bin/env node
'use strict';
/*
 * Seed the log with the servers you actually intend to contact.
 *
 *   node crawler/seed.js --top 25 --allow-exec
 *
 * Ranks npm-discovered MCP servers by last-month download count, keeps the
 * top N, probes only those, and reports which ones ended up with a page.
 * You do not need 500 servers to send 20 messages. You need the 20 servers
 * you are messaging to have a page worth looking at.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fromNpm } = require('./discover');
const { probe } = require('./probe');
const { PublicLog } = require('./log');

// Honour opt-out here too. The docs promise that adding a name stops the
// crawling, and a seeder that ignored the list would make that a lie.
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

const TOP = parseInt(flag('--top', '25'), 10);
const DATA = path.resolve(flag('--data', 'data'));
const ALLOW_EXEC = has('--allow-exec');
const SCRATCH = path.join(os.tmpdir(), 'mcp-pin-scratch');

async function downloads(names) {
  const counts = {};
  const plain = names.filter((n) => !n.startsWith('@'));
  const scoped = names.filter((n) => n.startsWith('@'));

  // The bulk endpoint takes up to 128 unscoped packages per call.
  for (let i = 0; i < plain.length; i += 100) {
    const batch = plain.slice(i, i + 100);
    try {
      const r = await fetch('https://api.npmjs.org/downloads/point/last-month/' + batch.join(','));
      if (!r.ok) continue;
      const j = await r.json();
      for (const k in j) if (j[k] && j[k].downloads) counts[k] = j[k].downloads;
    } catch {}
  }
  // Scoped packages have to be asked for one at a time.
  for (const n of scoped) {
    try {
      const r = await fetch('https://api.npmjs.org/downloads/point/last-month/' + encodeURIComponent(n));
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.downloads) counts[n] = j.downloads;
    } catch {}
    await new Promise((res) => setTimeout(res, 60));
  }
  return counts;
}

(async () => {
  process.stderr.write('discovering npm MCP servers...\n');
  const all = await fromNpm(250);
  process.stderr.write(`${all.length} candidates. ranking by downloads (this takes a minute)...\n`);

  const counts = await downloads(all.map((s) => s.name));
  const ranked = all
    .map((s) => Object.assign({}, s, { downloads: counts[s.name] || 0 }))
    .filter((s) => s.downloads > 0)
    .sort((a, b) => b.downloads - a.downloads);

  process.stderr.write(`${ranked.length} ranked. probing the top ${TOP}.\n\n`);

  fs.mkdirSync(DATA, { recursive: true });
  const log = new PublicLog(DATA);
  const state = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8')); }
    catch { return { servers: {} }; }
  })();

  const optout = loadOptOut();
  const targets = ranked.filter((s) => !optout.has(s.name.toLowerCase())).slice(0, TOP);
  if (optout.size) process.stderr.write(`honouring ${optout.size} opt-out entries\n`);
  const ok = [], failed = [];

  for (const s of targets) {
    process.stderr.write(`  ${String(s.downloads).padStart(8)}  ${s.name} ... `);
    const r = await probe(s, { allowExec: ALLOW_EXEC, scratch: SCRATCH, timeoutMs: 40000 });
    const now = new Date().toISOString();

    if (!r.ok) {
      process.stderr.write(`skip (${r.error})\n`);
      failed.push([s.name, r.error]);
      continue;
    }

    const prev = state.servers[s.id];
    const drifted = prev && prev.set_hash && prev.set_hash !== r.setHash;
    if (!prev || !prev.set_hash || drifted) {
      log.append({
        server_id: s.id, server_name: s.name, source: s.source, set_hash: r.setHash,
        tools: r.tools.map((t) => ({ name: t.name, hash: t.hash, canonical_json: t.canonical })),
      });
    }
    state.servers[s.id] = {
      id: s.id, name: s.name, source: s.source, description: s.description, homepage: s.homepage,
      downloads: s.downloads, set_hash: r.setHash, tool_count: r.count,
      first_seen_at: (prev && prev.first_seen_at) || now,
      last_probe_at: now,
      last_change_at: drifted ? now : (prev && prev.last_change_at) || null,
      last_error: null,
    };
    process.stderr.write(`ok, ${r.count} tools\n`);
    ok.push(s.name);
  }

  fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify(state, null, 2));
  log.signHead();

  process.stderr.write(`\n${ok.length} servers have a page. ${failed.length} skipped.\n`);
  if (ok.length < 20) {
    process.stderr.write(`\nFewer than 20 pages. Re-run with a larger --top to reach 20 contactable servers.\n`);
  }
  process.stderr.write('\nnext: node site/build.js && node crawler/outreach.js\n');
})();
