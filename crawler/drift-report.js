#!/usr/bin/env node
'use strict';
/*
 * The monthly drift report: what changed in the public log in one month,
 * counted from the signed log itself, with every gap in coverage stated.
 *
 *   npm run report:month                    the previous calendar month
 *   npm run report:month -- --month 2026-10 one month (a month in progress is marked partial)
 *
 * Writes data/reports/<month>.json; site/build.js renders it as
 * /reports/<month>.html. Per server it gives counts only. The change labels
 * are mechanical (a pattern in the new text, not a judgement), so they are
 * reported as totals, never against a named server.
 */
const fs = require('fs');
const path = require('path');
const { PublicLog } = require('./log');
const { classifyChange } = require('../src/classify');

const ROOT = path.join(__dirname, '..');
const DAY = 86400000;

function monthBounds(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error('--month must look like 2026-10');
  const start = Date.UTC(+m[1], +m[2] - 1, 1);
  const end = Date.UTC(+m[1], +m[2], 1);
  return { start, end };
}

function previousMonth(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

// What moved between two recorded versions of one server.
function toolChanges(prev, cur) {
  const before = new Map(prev.tools.map((t) => [t.name, t]));
  const after = new Set(cur.tools.map((t) => t.name));
  const out = { changed: 0, added: 0, removed: 0, schemaOnly: 0, labels: new Set() };
  for (const t of cur.tools) {
    const o = before.get(t.name);
    if (!o) { out.added++; out.labels.add('new-tool'); continue; }
    if (o.hash === t.hash) continue;
    out.changed++;
    const od = JSON.parse(o.canonical_json).description || '';
    const nd = JSON.parse(t.canonical_json).description || '';
    if (od === nd) out.schemaOnly++;
    for (const l of classifyChange(o.canonical_json, t.canonical_json)) out.labels.add(l.key);
  }
  for (const t of prev.tools) if (!after.has(t.name)) { out.removed++; out.labels.add('removed'); }
  return out;
}

function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; }
}

function build({ month, dataDir, now = new Date() }) {
  const { start, end } = monthBounds(month);
  const log = new PublicLog(dataDir);
  const entries = log.entries();
  const state = readJson(path.join(dataDir, 'state.json'), { servers: {} });
  const head = readJson(path.join(dataDir, 'head.json'), null);
  const gaps = readJson(path.join(dataDir, 'crawl-gaps.json'), []);
  const crawls = (() => {
    try {
      return fs.readFileSync(path.join(dataDir, 'crawls.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  })();
  const inMonth = (iso) => { const t = Date.parse(iso); return t >= start && t < end; };

  const byServer = new Map();
  for (const e of entries) {
    if (!byServer.has(e.server_id)) byServer.set(e.server_id, []);
    byServer.get(e.server_id).push(e);
  }

  // One row per server, however many times it changed in the month.
  const servers = [];
  const labelServers = {};
  const totals = { changed: 0, added: 0, removed: 0, schemaOnly: 0 };
  const windows = [];
  let events = 0;
  let envUnknown = 0;
  let recordedNew = 0;
  let tracked = 0;
  for (const [id, hist] of byServer) {
    hist.sort((a, b) => a.seq - b.seq);
    if (Date.parse(hist[0].observed_at) < end) tracked++;
    if (inMonth(hist[0].observed_at)) recordedNew++;
    let row = null;
    const labels = new Set();
    for (let i = 1; i < hist.length; i++) {
      const prev = hist[i - 1], cur = hist[i];
      if (!inMonth(cur.observed_at) || prev.set_hash === cur.set_hash) continue;
      events++;
      const c = toolChanges(prev, cur);
      totals.changed += c.changed; totals.added += c.added; totals.removed += c.removed; totals.schemaOnly += c.schemaOnly;
      for (const l of c.labels) labels.add(l);
      // The last good look before the change is only known for a server's
      // latest change. State is written a moment before the log entry.
      const st = state.servers[id] || {};
      const latest = i === hist.length - 1 && st.last_change_at && Math.abs(Date.parse(st.last_change_at) - Date.parse(cur.observed_at)) < 60000;
      const lookedBefore = latest && st.last_change_after ? st.last_change_after : null;
      if (lookedBefore) windows.push((Date.parse(cur.observed_at) - Date.parse(lookedBefore)) / DAY);
      // Whether the probe ran under the same conditions both times; unknown
      // for entries written before the log kept probe_env.
      const envKnown = prev.probe_env !== undefined && cur.probe_env !== undefined;
      if (!envKnown) envUnknown++;
      const envChanged = envKnown ? JSON.stringify(prev.probe_env) !== JSON.stringify(cur.probe_env) : null;
      if (!row) {
        row = { id, name: cur.server_name, changes: 0, first_seen_changed: cur.observed_at, last_look_before: null,
          tools_changed: 0, tools_added: 0, tools_removed: 0, schema_only: 0, probe_env_changed: null };
        if (!lookedBefore) row.previous_version_recorded = prev.observed_at;
      }
      row.changes++;
      row.last_seen_changed = cur.observed_at;
      if (row.changes === 1 && lookedBefore) row.last_look_before = lookedBefore;
      row.tools_changed += c.changed; row.tools_added += c.added; row.tools_removed += c.removed; row.schema_only += c.schemaOnly;
      if (envChanged !== null) row.probe_env_changed = row.probe_env_changed || envChanged;
    }
    if (row) {
      servers.push(row);
      for (const l of labels) labelServers[l] = (labelServers[l] || 0) + 1;
    }
  }
  servers.sort((a, b) => (b.tools_changed + b.tools_added + b.tools_removed) - (a.tools_changed + a.tools_added + a.tools_removed) || (a.name < b.name ? -1 : 1));

  const monthCrawls = crawls.filter((c) => inMonth(c.ran_at));
  const entryDays = [...new Set(entries.filter((e) => inMonth(e.observed_at)).map((e) => e.observed_at.slice(0, 10)))].sort();
  return {
    report: 'mcp-pin monthly drift report',
    month,
    partial: now.getTime() < end,
    generated_at: now.toISOString(),
    log: {
      entries: entries.length,
      verified_head: head ? { tree_size: head.tree_size, root_hash: head.root_hash, signed_at: head.signed_at } : null,
    },
    coverage: {
      tracked,
      recorded_new: recordedNew,
      crawl_runs: monthCrawls.length ? monthCrawls.map((c) => ({ ran_at: c.ran_at, probed_ok: c.probed_ok, candidates: c.candidates })) : null,
      days_with_entries: entryDays,
      gaps: gaps.filter((g) => Date.parse(g.from) < end && Date.parse(g.to) >= start),
    },
    changes: {
      servers: servers.length,
      events,
      tools: totals,
      labels: labelServers,
      days_between_looks: windows.length ? { median: Math.round(median(windows) * 10) / 10, max: Math.round(Math.max(...windows) * 10) / 10 } : null,
      probe_env_unknown: envUnknown,
    },
    servers,
    notes: [
      'Counted from the signed public log. Check it with: npx --yes mcp-pin verify-log',
      'A change is a new set of tool definitions recorded for a server that had one before. The log records versions, not the moment they changed: a change first seen on one day happened at some point after the last look before it.',
      'Labels are mechanical. Each means the new text has more of a pattern than the old one (an instruction to the model, words about secrets, a link, hidden characters) or that a field or permission hint moved. They are not a judgement of any server, so they are totals here, never shown against a named server.',
    ].concat(envUnknown ? [
      `For ${envUnknown} of these changes the log does not say what conditions the probe ran under (entries before 5 October 2026 dropped them; see the CHANGELOG). A listing can change because of the probe, missing credentials for example, rather than the server, so a large drop in tool count may not be the server's doing.`,
    ] : []),
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
  const month = flag('--month', previousMonth());
  const dataDir = path.resolve(flag('--data', path.join(ROOT, 'data')));
  const out = path.resolve(flag('--out', path.join(dataDir, 'reports')));
  const r = build({ month, dataDir });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, month + '.json'), JSON.stringify(r, null, 2) + '\n');
  const l = r.changes.labels;
  process.stdout.write([
    `${month}${r.partial ? ' (month in progress)' : ''}: ${r.coverage.tracked} servers tracked, ${r.coverage.recorded_new} recorded for the first time.`,
    `${r.changes.servers} servers changed their tool definitions (${r.changes.events} changes): ${r.changes.tools.changed} tools changed (${r.changes.tools.schemaOnly} in the schema only), ${r.changes.tools.added} added, ${r.changes.tools.removed} removed.`,
    `Servers with a change that ${['instruction', 'secrets', 'link', 'hidden', 'new-field', 'hints'].map((k) => `${k}: ${l[k] || 0}`).join(', ')}.`,
    r.changes.days_between_looks ? `Days between the last look and the first look that saw the change: median ${r.changes.days_between_looks.median}, at most ${Math.round(r.changes.days_between_looks.max)}.` : '',
    ...r.coverage.gaps.map((g) => `Gap: no crawl from ${g.from} to ${g.to} (${g.note}).`),
    `wrote ${path.join(out, month + '.json')}`,
  ].filter(Boolean).join('\n') + '\n');
}

module.exports = { build, toolChanges, previousMonth };
