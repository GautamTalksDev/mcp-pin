#!/usr/bin/env node
'use strict';
/*
 * mcp-pin. Pin the tools your agent was introduced to, and re-derive that
 * decision on every connect.
 *
 * usage:  npx mcp-pin -- <server command> [args...]
 *         npx mcp-pin list | show <id> | approve <id> | forget <id> | verify
 */
const { spawn } = require('child_process');
const fs = require('fs');
const readline = require('readline');
const { fingerprintToolset } = require('../src/canonical');
const store = require('../src/store');
const { renderDrift, C } = require('../src/diff');

const argv = process.argv.slice(2);

function usage(code) {
  process.stderr.write(
    `mcp-pin, tool-integrity pinning for MCP\n\n` +
      `  mcp-pin -- <server command> [args...]   run a server behind the proxy\n` +
      `  mcp-pin list                            pinned servers\n` +
      `  mcp-pin show <id>                       pinned tool fingerprints\n` +
      `  mcp-pin approve <id>                    accept the last observed drift\n` +
      `  mcp-pin forget <id>                     drop a pin (re-pins on next run)\n` +
      `  mcp-pin verify                          verify the local log chain\n\n` +
      `  --name <label>   friendly name for this server\n` +
      `  --yes            auto-approve first pin only (never approves drift)\n`
  );
  process.exit(code);
}

const sub = argv[0];
if (!argv.length) usage(1);

if (sub === 'list') return cmdList();
if (sub === 'show') return cmdShow(argv[1]);
if (sub === 'approve') return cmdApprove(argv[1]);
if (sub === 'forget') return cmdForget(argv[1]);
if (sub === 'verify') return cmdVerify();
if (sub === 'verify-log') return cmdVerifyLog(argv[1]);

/* ---------------------------------------------------------------- proxy */

const sep = argv.indexOf('--');
if (sep === -1) usage(1);
const flags = argv.slice(0, sep);
const cmdline = argv.slice(sep + 1);
if (!cmdline.length) usage(1);

const nameFlag = flags.indexOf('--name') !== -1 ? flags[flags.indexOf('--name') + 1] : null;
const command = cmdline[0];
const args = cmdline.slice(1);
const id = store.serverId(command, args);
const label = nameFlag || command + (args.length ? ' ' + args.join(' ') : '');

const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
child.on('error', (e) => {
  process.stderr.write(`mcp-pin: cannot start server: ${e.message}\n`);
  process.exit(127);
});

let blocked = false;

// client -> server (pass through untouched; we only observe)
process.stdin.pipe(child.stdin);

// server -> client (inspect tools/list results before they reach the model)
const rl = readline.createInterface({ input: child.stdout });
const probeId = 'mcp-pin-probe-' + process.pid;
let probed = false;

rl.on('line', (line) => {
  if (blocked) return;
  let msg = null;
  try { msg = JSON.parse(line); } catch { process.stdout.write(line + '\n'); return; }

  // Probe once, as soon as the server is initialized, so drift is caught
  // before the client can call anything.
  if (!probed && msg.result && msg.result.protocolVersion) {
    probed = true;
    process.stdout.write(line + '\n');
    setTimeout(() => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: probeId, method: 'tools/list' }) + '\n'), 0);
    return;
  }

  if (msg.result && Array.isArray(msg.result.tools)) {
    const verdict = check(msg.result.tools);
    if (verdict.blocked) {
      blocked = true;
      if (msg.id !== probeId) {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          error: { code: -32001, message: 'mcp-pin: tool definitions changed since approval; session blocked' },
        }) + '\n');
      }
      halt(verdict);
      return;
    }
    if (msg.id === probeId) return; // swallow our own probe
  }

  process.stdout.write(line + '\n');
});

child.on('exit', (code) => process.exit(blocked ? 42 : code === null ? 1 : code));
process.on('SIGINT', () => { child.kill('SIGINT'); });

/* ------------------------------------------------------------ the check */

function check(tools) {
  const fp = fingerprintToolset(tools);
  const pin = store.getPin(id);

  if (!pin) {
    store.setPin(id, { id, label, command, args, setHash: fp.setHash, tools: fp.tools, pinned_at: new Date().toISOString() });
    store.append({ type: 'pin', server_id: id, label, set_hash: fp.setHash, tools: fp.tools.map((t) => ({ name: t.name, hash: t.hash, canonical_json: t.canonical })) });
    process.stderr.write(C.dim(`mcp-pin: pinned ${fp.tools.length} tool(s) for ${label} (${fp.setHash.slice(0, 12)})\n`));
    return { blocked: false };
  }

  if (pin.setHash === fp.setHash) {
    process.stderr.write(C.dim(`mcp-pin: ${fp.tools.length} tool(s) unchanged (${fp.setHash.slice(0, 12)})\n`));
    return { blocked: false };
  }

  const oldByName = new Map(pin.tools.map((t) => [t.name, t]));
  const newByName = new Map(fp.tools.map((t) => [t.name, t]));
  const drift = [];
  for (const [name, t] of newByName) {
    const o = oldByName.get(name);
    if (!o) drift.push({ kind: 'added', name });
    else if (o.hash !== t.hash) drift.push({ kind: 'changed', name, oldCanonical: o.canonical, newCanonical: t.canonical });
  }
  for (const name of oldByName.keys()) if (!newByName.has(name)) drift.push({ kind: 'removed', name });

  store.append({ type: 'drift', server_id: id, label, set_hash: fp.setHash, prev_set_hash: pin.setHash, tools: fp.tools.map((t) => ({ name: t.name, hash: t.hash, canonical_json: t.canonical })) });
  store.setPin(id, Object.assign({}, pin, { pending: { setHash: fp.setHash, tools: fp.tools, observed_at: new Date().toISOString() } }));
  return { blocked: true, drift, fp };
}

function halt(verdict) {
  const out = [
    '',
    C.bold(C.red('  ⛔ mcp-pin: TOOL DEFINITIONS CHANGED SINCE YOU APPROVED THIS SERVER')),
    '',
    `  server: ${label}`,
    `  id:     ${id}`,
    `  pinned: ${store.getPin(id).pinned_at}`,
    '',
    renderDrift(verdict.drift),
    '',
    C.bold('  This session is blocked. Nothing was sent to the model.'),
    `  Review the diff. If you accept it:  ${C.bold('mcp-pin approve ' + id)}`,
    `  Otherwise, do nothing — the pin stands.`,
    '',
  ].join('\n');
  process.stderr.write(out);
  try { fs.writeSync(1, ''); } catch {}
  child.kill('SIGTERM');
  setTimeout(() => process.exit(42), 50);
}

/* -------------------------------------------------------------- commands */

function cmdList() {
  const pins = store.readPins();
  const keys = Object.keys(pins);
  if (!keys.length) return process.stdout.write('no pinned servers yet\n');
  for (const k of keys) {
    const p = pins[k];
    const flag = p.pending ? C.red('  DRIFT PENDING REVIEW') : '';
    process.stdout.write(`${k}  ${p.tools.length} tools  ${p.setHash.slice(0, 12)}  ${p.label}${flag}\n`);
  }
}

function cmdShow(k) {
  const p = k && store.getPin(k);
  if (!p) { process.stderr.write('unknown server id\n'); process.exit(1); }
  process.stdout.write(`${p.label}\npinned ${p.pinned_at}\nset ${p.setHash}\n\n`);
  for (const t of p.tools) process.stdout.write(`  ${t.hash.slice(0, 16)}  ${t.name}\n`);
}

function cmdApprove(k) {
  const p = k && store.getPin(k);
  if (!p) { process.stderr.write('unknown server id\n'); process.exit(1); }
  if (!p.pending) { process.stdout.write('nothing pending\n'); return; }
  store.setPin(k, { id: p.id, label: p.label, command: p.command, args: p.args, setHash: p.pending.setHash, tools: p.pending.tools, pinned_at: new Date().toISOString() });
  store.append({ type: 'approve', server_id: k, label: p.label, set_hash: p.pending.setHash });
  process.stdout.write(`re-pinned ${p.label} at ${p.pending.setHash.slice(0, 12)}\n`);
}

function cmdForget(k) {
  store.deletePin(k);
  process.stdout.write('forgotten; will re-pin on next connect\n');
}

// Verify a downloaded public log offline: chain integrity + signed head.
function cmdVerifyLog(dir) {
  const { PublicLog } = require('../crawler/log');
  const target = dir || '.';
  const r = new PublicLog(target).verify();
  if (r.ok) {
    process.stdout.write(`public log OK — ${r.count} entries, chain intact, head signature valid\n`);
  } else {
    process.stderr.write(`public log FAILED: ${r.reason}\n`);
    process.exit(1);
  }
}

function cmdVerify() {
  const r = store.verifyLog();
  if (r.ok) process.stdout.write(`log ok — ${r.count} entries, chain intact\n`);
  else { process.stderr.write(`log BROKEN at entry ${r.index}: ${r.reason}\n`); process.exit(1); }
}
