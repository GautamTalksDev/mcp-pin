#!/usr/bin/env node
'use strict';
/*
 * What changed, and what should I do about it.
 *
 *   npm run report              changes in the last 24h
 *   npm run report -- --days 7  changes in the last 7 days
 *   npm run report -- --all     every change ever recorded
 *   npm run report -- --contacted   only servers listed in OUTREACH.md
 *
 * This exists so the daily question "did anything move" is one command
 * rather than an archaeology session.
 */
const fs = require('fs');
const path = require('path');
const { PublicLog } = require('./log');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const has = (n) => args.indexOf(n) !== -1;

const DATA = path.resolve(flag('--data', path.join(ROOT, 'data')));
const DAYS = has('--all') ? 1e9 : parseFloat(flag('--days', '1'));
const SITE = process.env.SITE_URL || 'https://mcp-pin.gautamkhosla.com';

const C = process.stdout.isTTY
  ? { r: (s) => `\x1b[31m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`,
      a: (s) => `\x1b[33m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
      d: (s) => `\x1b[2m${s}\x1b[0m` }
  : { r: (s) => s, g: (s) => s, a: (s) => s, b: (s) => s, d: (s) => s };

// Servers already contacted, read straight from the outreach log.
function contacted() {
  const set = new Set();
  try {
    for (const line of fs.readFileSync(path.join(ROOT, 'OUTREACH.md'), 'utf8').split('\n')) {
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length > 2 && cells[2] && cells[2] !== 'Server') set.add(cells[2].toLowerCase());
    }
  } catch {}
  return set;
}

function diffTools(a, b) {
  const prev = new Map(a.tools.map((t) => [t.name, t]));
  const rows = [];
  for (const t of b.tools) {
    const o = prev.get(t.name);
    if (o === undefined) { rows.push({ kind: 'added', name: t.name }); continue; }
    if (o.hash === t.hash) continue;
    const od = (JSON.parse(o.canonical_json).description || '');
    const nd = (JSON.parse(t.canonical_json).description || '');
    rows.push({
      kind: 'changed', name: t.name, from: od.length, to: nd.length,
      schemaOnly: od === nd,
      firstDiff: od === nd ? null : firstDifference(od, nd),
    });
  }
  const cur = new Set(b.tools.map((t) => t.name));
  for (const t of a.tools) if (cur.has(t.name) === false) rows.push({ kind: 'removed', name: t.name });
  return rows;
}

function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return { at: i, was: a.slice(Math.max(0, i - 30), i + 70), now: b.slice(Math.max(0, i - 30), i + 70) };
}

(function main() {
  const log = new PublicLog(DATA);
  const state = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'));
  const servers = Object.values(state.servers).filter((s) => s.set_hash);
  const known = contacted();
  const cutoff = Date.now() - DAYS * 86400000;

  const changed = servers
    .filter((s) => s.last_change_at && new Date(s.last_change_at).getTime() >= cutoff)
    .filter((s) => (has('--contacted') ? known.has(String(s.name).toLowerCase()) : true))
    .sort((a, b) => new Date(b.last_change_at) - new Date(a.last_change_at));

  const v = log.verify();
  const window = has('--all') ? 'all time' : `last ${DAYS === 1 ? '24 hours' : DAYS + ' days'}`;

  console.log('');
  console.log(C.b(`  ${servers.length} servers tracked · ${log.entries().length} log entries · ` +
    (v.ok ? C.g('log verifies') : C.r('LOG FAILS: ' + v.reason))));
  console.log(C.d(`  ${changed.length} changed in the ${window}` + (has('--contacted') ? ', filtered to servers you contacted' : '')));

  if (changed.length === 0) {
    console.log(C.d('\n  Nothing moved. That is the normal case and it is a good sign.\n'));
    return;
  }

  let schemaOnlyCount = 0;
  for (const s of changed) {
    const h = log.history(s.id);
    if (h.length < 2) continue;
    const a = h[h.length - 2], b = h[h.length - 1];
    const rows = diffTools(a, b);
    if (rows.length === 0) continue;

    const mark = known.has(String(s.name).toLowerCase()) ? C.g(' [contacted]') : '';
    console.log('\n' + C.b('  ' + s.name) + mark);
    console.log(C.d(`    ${a.observed_at.slice(0, 16).replace('T', ' ')} -> ${b.observed_at.slice(0, 16).replace('T', ' ')} UTC`));
    console.log(C.d(`    ${SITE}/servers/${s.id}.html`));
    if (s.homepage) console.log(C.d('    ' + s.homepage.replace(/^git\+/, '')));

    for (const r of rows) {
      if (r.kind === 'added') { console.log('    ' + C.g('+ tool added: ' + r.name)); continue; }
      if (r.kind === 'removed') { console.log('    ' + C.r('- tool removed: ' + r.name)); continue; }
      if (r.schemaOnly) {
        schemaOnlyCount++;
        console.log('    ' + C.r(`~ ${r.name}  ${r.from} chars, description IDENTICAL, hash differs`));
        console.log('      ' + C.a('schema or annotations moved, the text did not. A docs diff would miss this.'));
      } else {
        console.log('    ' + C.a(`~ ${r.name}  ${r.from} -> ${r.to} chars`));
        if (r.firstDiff) {
          console.log(C.d('      was: ' + JSON.stringify(r.firstDiff.was)));
          console.log(C.d('      now: ' + JSON.stringify(r.firstDiff.now)));
        }
      }
    }
  }

  console.log('');
  if (schemaOnlyCount) {
    console.log(C.b(`  ${schemaOnlyCount} schema-only change${schemaOnlyCount === 1 ? '' : 's'}.`) +
      C.d(' Those are the ones worth telling a maintainer about.'));
  }
  console.log(C.d('  Contacted servers are marked. A dated diff on a thread you already opened'));
  console.log(C.d('  is a reason to follow up that has nothing to do with promotion.\n'));
})();
