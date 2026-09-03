#!/usr/bin/env node
'use strict';
/*
 * mcp-pin GitHub Action.
 *
 * Starts the MCP server built from this branch, fingerprints every tool's
 * full metadata surface, and compares it against a baseline committed in the
 * repository. Any drift is reported on the pull request as a diff.
 *
 * The baseline lives in the maintainer's own repo, not in anyone's hosted
 * log. Adopting this requires trusting no third party service, which is the
 * whole point: a supply-chain check you have to phone home for is not one.
 *
 * The finding this exists for: a tool whose description is byte-identical
 * while its input schema moved. That is invisible in a normal code review
 * diff and it still changes what the model does.
 */
const fs = require('fs');
const path = require('path');
const { probe } = require('../crawler/probe');
const { renderToolDiff } = require('../src/diff');

// GitHub sets INPUT_<NAME> with spaces replaced by underscores and dashes
// left intact, which is awkward to set by hand. Accept both spellings so the
// action behaves the same in CI and when someone runs it locally.
const inp = (name, dflt = '') => {
  const base = name.toUpperCase().replace(/ /g, '_');
  const v = process.env['INPUT_' + base];
  const u = process.env['INPUT_' + base.replace(/-/g, '_')];
  const picked = v !== undefined && v !== '' ? v : u;
  return picked === undefined || picked === '' ? dflt : picked;
};
const bool = (name, dflt) => {
  const v = inp(name, String(dflt)).toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
};

const COMMAND = inp('command');
const ARGS = inp('args');
const URL_ = inp('url');
const BASELINE = path.resolve(inp('baseline', '.mcp-pin/tools.json'));
const FAIL_ON_CHANGE = bool('fail-on-change', false);
const COMMENT = bool('comment', true);
const UPDATE = bool('update-baseline', false);

function log(msg) { process.stdout.write(msg + '\n'); }
function notice(msg) { log('::notice::' + msg); }
function warn(msg) { log('::warning::' + msg); }
function fail(msg) { log('::error::' + msg); }

function strip(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }

// ---------------------------------------------------------------- diffing

// Both arguments are records: { set_hash, tools: [{name, hash, canonical_json}] }.
// Normalising before comparing avoids mixing the probe's shape with the
// baseline's, which is exactly the kind of mismatch this tool exists to catch.
function compare(baseline, observed) {
  const prev = new Map(baseline.tools.map((t) => [t.name, t]));
  const rows = [];

  for (const t of observed.tools) {
    const o = prev.get(t.name);
    if (o === undefined) { rows.push({ kind: 'added', name: t.name }); continue; }
    if (o.hash === t.hash) continue;
    const od = JSON.parse(o.canonical_json).description || '';
    const nd = JSON.parse(t.canonical_json).description || '';
    rows.push({
      kind: 'changed',
      name: t.name,
      schemaOnly: od === nd,
      from: od.length,
      to: nd.length,
      diff: strip(renderToolDiff(t.name, o.canonical_json, t.canonical_json)),
    });
  }

  const cur = new Set(observed.tools.map((t) => t.name));
  for (const t of baseline.tools) if (cur.has(t.name) === false) rows.push({ kind: 'removed', name: t.name });

  return rows;
}

function report(rows, observed, baseline) {
  const changed = rows.filter((r) => r.kind === 'changed');
  const schemaOnly = changed.filter((r) => r.schemaOnly);
  const added = rows.filter((r) => r.kind === 'added');
  const removed = rows.filter((r) => r.kind === 'removed');

  let md = '## mcp-pin: tool definitions changed\n\n';
  md += `\`${baseline.set_hash.slice(0, 12)}\` → \`${observed.set_hash.slice(0, 12)}\`\n\n`;

  const bits = [];
  if (changed.length) bits.push(`${changed.length} changed`);
  if (added.length) bits.push(`${added.length} added`);
  if (removed.length) bits.push(`${removed.length} removed`);
  md += bits.join(' · ') + '\n\n';

  if (schemaOnly.length) {
    md += `> **${schemaOnly.length} of these changed their schema or annotations while the description stayed byte-identical.**\n`;
    md += '> Those are invisible in a normal diff of the description text, and they still change what the model does.\n\n';
  }

  for (const r of added) md += `- **added**: \`${r.name}\`\n`;
  for (const r of removed) md += `- **removed**: \`${r.name}\`\n`;
  if (added.length || removed.length) md += '\n';

  for (const r of changed) {
    md += `<details><summary><code>${r.name}</code>`;
    md += r.schemaOnly
      ? ' — schema changed, description identical</summary>\n\n'
      : ` — description ${r.from} → ${r.to} chars</summary>\n\n`;
    md += '```diff\n' + r.diff.slice(0, 4000) + '\n```\n\n</details>\n\n';
  }

  md += '---\n';
  md += 'Every tool\'s name, description, input schema and annotations are hashed with SHA-256 ';
  md += 'over an RFC 8785 canonical serialization. Nothing is sent anywhere; the baseline lives in this repository. ';
  md += '[mcp-pin](https://github.com/GautamTalksDev/mcp-pin)\n';
  return md;
}

// ------------------------------------------------------------ pr comment

async function upsertComment(body) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) { warn('no GITHUB_TOKEN or repository, skipping the PR comment'); return; }

  let prNumber = null;
  try {
    const ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    prNumber = (ev.pull_request && ev.pull_request.number) || (ev.issue && ev.issue.number);
  } catch {}
  if (!prNumber) { notice('not a pull request, skipping the comment'); return; }

  const api = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': 'mcp-pin-action',
  };
  const MARKER = '<!-- mcp-pin -->';
  const payload = MARKER + '\n' + body;

  // Update the existing comment rather than stacking a new one per push.
  try {
    const r = await fetch(api + '?per_page=100', { headers });
    if (r.ok) {
      const existing = (await r.json()).find((c) => c.body && c.body.includes(MARKER));
      if (existing) {
        await fetch(`https://api.github.com/repos/${repo}/issues/comments/${existing.id}`,
          { method: 'PATCH', headers, body: JSON.stringify({ body: payload }) });
        notice('updated the existing mcp-pin comment');
        return;
      }
    }
  } catch (e) { warn('could not list comments: ' + e.message); }

  try {
    const r = await fetch(api, { method: 'POST', headers, body: JSON.stringify({ body: payload }) });
    if (!r.ok) warn('could not post the comment: ' + r.status);
    else notice('posted an mcp-pin comment');
  } catch (e) { warn('could not post the comment: ' + e.message); }
}

function summary(md) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) { try { fs.appendFileSync(f, md + '\n'); } catch {} }
}

function setOutput(name, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) { try { fs.appendFileSync(f, `${name}=${value}\n`); } catch {} }
}

// ------------------------------------------------------------------ main

(async () => {
  if (!COMMAND && !URL_) {
    fail('set either `command` (with optional `args`) or `url`');
    process.exit(1);
  }

  const install = URL_
    ? { type: 'http', url: URL_ }
    : { type: 'stdio', command: COMMAND, args: ARGS ? ARGS.split(/\s+/).filter(Boolean) : [] };

  log(`mcp-pin: probing ${URL_ || COMMAND + ' ' + ARGS}`);
  const observed = await probe({ install }, { allowExec: true, timeoutMs: 60000 });
  if (!observed.ok) {
    fail('could not read tools/list from the server: ' + observed.error);
    process.exit(1);
  }
  log(`mcp-pin: ${observed.count} tools, set hash ${observed.setHash.slice(0, 12)}`);
  setOutput('tool-count', observed.count);
  setOutput('set-hash', observed.setHash);

  const record = {
    version: 1,
    generated_by: 'mcp-pin',
    recorded_at: new Date().toISOString(),
    set_hash: observed.setHash,
    tools: observed.tools.map((t) => ({ name: t.name, hash: t.hash, canonical_json: t.canonical })),
  };

  if (!fs.existsSync(BASELINE) || UPDATE) {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify(record, null, 2) + '\n');
    const msg = fs.existsSync(BASELINE) && UPDATE
      ? `baseline updated at ${inp('baseline', '.mcp-pin/tools.json')}, commit it`
      : `no baseline found, wrote one to ${inp('baseline', '.mcp-pin/tools.json')}. Commit it and future changes will be diffed against it.`;
    notice(msg);
    summary('## mcp-pin\n\n' + msg + '\n');
    setOutput('changed', 'false');
    return;
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));

  if (baseline.set_hash === observed.setHash) {
    const msg = `mcp-pin: ${observed.count} tool(s) unchanged (${observed.setHash.slice(0, 12)})`;
    log(msg);
    notice(msg);
    summary('## mcp-pin\n\nNo change. ' + observed.count + ' tools match the committed baseline.\n');
    setOutput('changed', 'false');
    return;
  }

  const rows = compare(baseline, record);
  const md = report(rows, record, baseline);
  log(strip(md));
  summary(md);
  setOutput('changed', 'true');
  setOutput('schema-only-count', rows.filter((r) => r.kind === 'changed' && r.schemaOnly).length);

  if (COMMENT) await upsertComment(md);

  if (FAIL_ON_CHANGE) {
    fail('tool definitions changed. Review the diff, then re-run with update-baseline to accept it.');
    process.exit(1);
  }
  warn('tool definitions changed since the committed baseline');
})().catch((e) => {
  fail('mcp-pin action failed: ' + (e && e.message));
  process.exit(1);
});
