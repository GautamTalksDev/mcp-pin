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
const path = require('path');
const readline = require('readline');
const { fingerprintToolset } = require('../src/canonical');
const store = require('../src/store');
const { collectAllTools } = require('../src/list-tools');
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

function failCorrupt(e) {
  if (!e || e.name !== 'CorruptStateError') return false;
  process.stderr.write('mcp-pin: corrupt state at ' + e.path + '\n');
  process.stderr.write(
    'The store could not be read. Restore this file from backup or remove it.\n' +
      'mcp-pin will not start until the store is readable.\n'
  );
  process.exit(1);
}

function displayLabel(command, args, nameFlag) {
  if (nameFlag) return String(nameFlag);
  const base = path.basename(command);
  const n = (args || []).length;
  return n === 0 ? base : base + ' [' + n + ' arg' + (n === 1 ? '' : 's') + ']';
}

function pinRecord(id, label, fp, extra) {
  // Never persist raw argv. Command lines frequently contain API keys.
  return Object.assign({
    id,
    label,
    setHash: fp.setHash,
    tools: fp.tools,
    pinned_at: new Date().toISOString(),
  }, extra || {});
}

const sub = argv[0];
if (!argv.length) usage(1);

try {
  if (sub === 'list') cmdList();
  else if (sub === 'show') cmdShow(argv[1]);
  else if (sub === 'approve') cmdApprove(argv[1]);
  else if (sub === 'forget') cmdForget(argv[1]);
  else if (sub === 'verify') cmdVerify();
  else if (sub === 'verify-log') cmdVerifyLog(argv[1]);
  else runProxy();
} catch (e) {
  failCorrupt(e);
  throw e;
}

/* ---------------------------------------------------------------- proxy */

function runProxy() {
  const sep = argv.indexOf('--');
  if (sep === -1) usage(1);
  const flags = argv.slice(0, sep);
  const cmdline = argv.slice(sep + 1);
  if (!cmdline.length) usage(1);

  const nameFlag = flags.indexOf('--name') !== -1 ? flags[flags.indexOf('--name') + 1] : null;
  const command = cmdline[0];
  const args = cmdline.slice(1);
  const id = store.serverId(command, args);
  const label = displayLabel(command, args, nameFlag);

  // Fail closed before the untrusted server is even spawned.
  try {
    store.ensure();
    store.getPin(id);
  } catch (e) {
    failCorrupt(e);
    throw e;
  }

  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  child.on('error', (e) => {
    process.stderr.write(`mcp-pin: cannot start server: ${e.message}\n`);
    process.exit(127);
  });
  child.stdin.on('error', () => {});

  const INIT = 'INIT', LISTING = 'LISTING', VERIFYING = 'VERIFYING', RELEASED = 'RELEASED', BLOCKED = 'BLOCKED';
  let state = INIT;
  const inbound = [];
  const outbound = [];
  let heldInit = null;
  let verifying = false;
  let probeSeq = 0;
  const pending = new Map();

  function sendToServer(obj) {
    child.stdin.write(JSON.stringify(obj) + '\n');
  }

  function sendToClient(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }

  function rejectAll(err) {
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  }

  function sendRequest(method, params) {
    const rid = 'mcp-pin-' + process.pid + '-' + (++probeSeq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(rid);
        reject(new Error(method + ' timed out'));
      }, 30000);
      pending.set(rid, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const msg = { jsonrpc: '2.0', id: rid, method };
      if (params !== undefined) msg.params = params;
      sendToServer(msg);
    });
  }

  function flushInbound() {
    for (const line of inbound) {
      let msg;
      try { msg = JSON.parse(line); } catch {
        child.stdin.write(line + '\n');
        continue;
      }
      if (msg.method === 'notifications/initialized') continue;
      sendToServer(msg);
    }
    inbound.length = 0;
  }

  function enterBlocked() {
    state = BLOCKED;
    inbound.length = 0;
    outbound.length = 0;
    rejectAll(new Error('session blocked'));
  }

  function halt(verdict) {
    enterBlocked();
    const pin = (() => { try { return store.getPin(id); } catch { return null; } })();
    const out = [
      '',
      C.bold(C.red('  ⛔ mcp-pin: TOOL DEFINITIONS CHANGED SINCE YOU APPROVED THIS SERVER')),
      '',
      `  server: ${label}`,
      `  id:     ${id}`,
      `  pinned: ${pin && pin.pinned_at ? pin.pinned_at : 'unknown'}`,
      '',
      renderDrift(verdict.drift),
      '',
      C.bold('  This session is blocked. Nothing queued was forwarded to the server.'),
      `  Review the diff. If you accept it:  ${C.bold('mcp-pin approve ' + id)}`,
      `  Otherwise, do nothing and the pin stands.`,
      '',
    ].join('\n');
    process.stderr.write(out);
    try { fs.writeSync(1, ''); } catch {}
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => process.exit(42), 50);
  }

  function check(tools) {
    const fp = fingerprintToolset(tools);
    const pin = store.getPin(id);

    if (!pin) {
      store.setPin(id, pinRecord(id, label, fp));
      store.append({
        type: 'pin',
        server_id: id,
        label,
        set_hash: fp.setHash,
        tools: fp.tools.map((t) => ({ name: t.name, hash: t.hash, canonical_json: t.canonical })),
      });
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

    store.append({
      type: 'drift',
      server_id: id,
      label,
      set_hash: fp.setHash,
      prev_set_hash: pin.setHash,
      tools: fp.tools.map((t) => ({ name: t.name, hash: t.hash, canonical_json: t.canonical })),
    });
    store.setPin(id, Object.assign({}, pin, {
      pending: { setHash: fp.setHash, tools: fp.tools, observed_at: new Date().toISOString() },
    }));
    return { blocked: true, drift, fp };
  }

  async function startVerify() {
    if (verifying) return;
    verifying = true;
    state = LISTING;
    try {
      sendToServer({ jsonrpc: '2.0', method: 'notifications/initialized' });
      state = VERIFYING;
      const tools = await collectAllTools(sendRequest);
      const verdict = check(tools);
      if (verdict.blocked) {
        halt(verdict);
        return;
      }
      state = RELEASED;
      sendToClient(heldInit);
      heldInit = null;
      for (const line of outbound) process.stdout.write(line.endsWith('\n') ? line : line + '\n');
      outbound.length = 0;
      flushInbound();
    } catch (e) {
      if (e && e.name === 'CorruptStateError') {
        enterBlocked();
        failCorrupt(e);
      }
      enterBlocked();
      process.stderr.write('mcp-pin: verification failed: ' + e.message + '\n');
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => process.exit(1), 50);
    }
  }

  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (state === BLOCKED) return;
    if (state === RELEASED) {
      child.stdin.write(line + '\n');
      return;
    }
    let msg;
    try { msg = JSON.parse(line); } catch {
      inbound.push(line);
      return;
    }
    if (state === INIT && msg.method === 'initialize') {
      sendToServer(msg);
      return;
    }
    inbound.push(line);
  });

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (state === BLOCKED) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      if (state === RELEASED) process.stdout.write(line + '\n');
      else outbound.push(line);
      return;
    }

    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'rpc error'));
      else if (msg.result === undefined) p.reject(new Error('malformed rpc result'));
      else p.resolve(msg.result);
      return;
    }

    if (state !== RELEASED && msg.result && msg.result.protocolVersion && !heldInit) {
      heldInit = msg;
      startVerify();
      return;
    }

    if (state === RELEASED) process.stdout.write(line + '\n');
    else outbound.push(line);
  });

  child.on('exit', (code) => {
    rejectAll(new Error('server exited'));
    if (state === BLOCKED) return;
    process.exit(code === null ? 1 : code);
  });
  process.on('SIGINT', () => { child.kill('SIGINT'); });
}

/* -------------------------------------------------------------- commands */

function cmdList() {
  const pins = store.readPins();
  const keys = Object.keys(pins);
  if (!keys.length) return process.stdout.write('no pinned servers yet\n');
  for (const k of keys) {
    const p = pins[k];
    const flag = p.pending ? C.red('  DRIFT PENDING REVIEW') : '';
    const n = p.tools ? p.tools.length : 0;
    const hash = p.setHash ? p.setHash.slice(0, 12) : '?';
    process.stdout.write(`${k}  ${n} tools  ${hash}  ${p.label || k}${flag}\n`);
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
  store.setPin(k, pinRecord(p.id || k, p.label, { setHash: p.pending.setHash, tools: p.pending.tools }));
  store.append({ type: 'approve', server_id: k, label: p.label, set_hash: p.pending.setHash });
  process.stdout.write(`re-pinned ${p.label} at ${p.pending.setHash.slice(0, 12)}\n`);
}

function cmdForget(k) {
  store.deletePin(k);
  process.stdout.write('forgotten; will re-pin on next connect\n');
}

function cmdVerifyLog(dir) {
  const { PublicLog, parsePublicKeyFile } = require('../crawler/log');
  const target = dir || '.';
  const keyFile = path.join(__dirname, '..', 'PUBLIC_KEY.txt');
  let trusted;
  try {
    trusted = parsePublicKeyFile(fs.readFileSync(keyFile, 'utf8'));
  } catch (e) {
    process.stderr.write('mcp-pin: cannot read bundled PUBLIC_KEY.txt: ' + e.message + '\n');
    process.exit(1);
  }
  const r = new PublicLog(target).verify({ trustedPublicKey: trusted });
  if (r.ok) {
    process.stdout.write(`public log OK, ${r.count} entries, chain intact, head signature valid\n`);
  } else {
    process.stderr.write(`public log FAILED: ${r.reason}\n`);
    process.exit(1);
  }
}

function cmdVerify() {
  const r = store.verifyLog();
  if (r.ok) process.stdout.write(`log ok, ${r.count} entries, chain intact\n`);
  else { process.stderr.write(`log BROKEN at entry ${r.index}: ${r.reason}\n`); process.exit(1); }
}
