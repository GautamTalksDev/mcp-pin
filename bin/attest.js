#!/usr/bin/env node
'use strict';
/*
 * mcp-pin. Pin the tools your agent was introduced to, and re-derive that
 * decision on every connect.
 *
 * usage:  npx mcp-pin -- <server command> [args...]
 *         npx mcp-pin list | show <id> | review <id> | approve <id> | forget <id> | verify
 */
const { spawnServer } = require('../src/spawn');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { fingerprintTool, sha256, repeatsMemberName } = require('../src/canonical');
const { observe, diffDefinitions, definitionFields, logDefinitions } = require('../src/definitions');
const store = require('../src/store');
const { collectAllTools, collectAllPrompts } = require('../src/list-tools');
const { renderDrift, renderSummary, visible, C } = require('../src/diff');
const { summarize } = require('../src/classify');

const argv = process.argv.slice(2);

function usage(code) {
  process.stderr.write(
    `mcp-pin, tool-integrity pinning for MCP\n\n` +
      `  mcp-pin -- <server command> [args...]   run a server behind the proxy\n` +
      `  mcp-pin wrap                            protect every local MCP server in your AI apps\n` +
      `  mcp-pin unwrap                          take mcp-pin out of those configs again\n` +
      `  mcp-pin lock [--check]                  write or check the team's mcp-pin.lock\n` +
      `  mcp-pin policy <product|all>            admin policy requiring mcp-pin: claude-code, copilot, codex, cursor\n` +
      `  mcp-pin list                            pinned servers\n` +
      `  mcp-pin show <id>                       pinned tool fingerprints\n` +
      `  mcp-pin review <id>                     show what changed since you approved it\n` +
      `  mcp-pin approve <id>                    accept the last observed drift\n` +
      `  mcp-pin forget <id>                     drop a pin (re-pins on next run)\n` +
      `  mcp-pin verify                          verify the local log chain\n` +
      `  mcp-pin demo                            watch a changed tool get blocked (10 s)\n` +
      `  mcp-pin lookup [--http <port>]          mcp-pin as an MCP server: status and review tools\n\n` +
      `  --name <label>   friendly name for this server\n` +
      `  --yes            auto-approve first pin only (never approves drift)\n` +
      `  --lock <file>    pin against a team lockfile instead of this machine's pin\n` +
      `  --only-locked    with --lock: refuse to run a server the lock does not list\n\n` +
      `  lock:           --config <file> (default .mcp.json)   --out <file> (default mcp-pin.lock)\n` +
      `                  --definitions-only  skip package versions (for packages the registry will not show)\n` +
      `  wrap / unwrap:  --yes apply without asking   --dry-run show only\n` +
      `                  --config <file> another config   --project also ./.mcp.json\n` +
      `                  --lock <file> with --project: every teammate's proxy checks the lock\n`
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
  if (sub === 'wrap' || sub === 'unwrap') cmdWrap(sub);
  else if (sub === 'lock') {
    cmdLock().catch((e) => { process.stderr.write('mcp-pin lock: ' + e.message + '\n'); process.exit(2); });
  }
  else if (sub === 'policy') cmdPolicy(argv[1]);
  else if (sub === 'lookup') {
    const lookup = require('../src/lookup');
    const i = argv.indexOf('--http');
    if (i !== -1) lookup.serveHttp(Number(argv[i + 1]) || 8787, '127.0.0.1');
    else lookup.serveStdio();
  }
  else if (sub === 'list') cmdList();
  else if (sub === 'show') cmdShow(argv[1]);
  else if (sub === 'review') cmdReview(argv[1]);
  else if (sub === 'approve') cmdApprove(argv[1]);
  else if (sub === 'forget') cmdForget(argv[1]);
  else if (sub === 'verify') cmdVerify();
  else if (sub === 'verify-log') cmdVerifyLog(argv[1]);
  else if (sub === 'demo') {
    require('../src/demo').run().then(
      (code) => process.exit(code),
      (e) => { process.stderr.write('mcp-pin demo: ' + e.message + '\n'); process.exit(1); }
    );
  }
  else runProxy();
} catch (e) {
  failCorrupt(e);
  throw e;
}

/* ---------------------------------------------------------------- proxy */

// Error codes outside the JSON-RPC reserved range (-32768 to -32000), which
// MCP 2026-07-28 leaves for application-defined errors.
const BLOCKED_CODE = -31042;
const UNVERIFIED_CODE = -31043;

// MCP 2026-07-28 ("modern") has no initialize handshake: every request
// carries its protocol version and client capabilities in _meta. Older
// ("legacy") clients still open with initialize. The proxy serves both.
const PV = 'io.modelcontextprotocol/protocolVersion';
const CC = 'io.modelcontextprotocol/clientCapabilities';
const CI = 'io.modelcontextprotocol/clientInfo';

// Client requests whose responses carry text the model reads. Every one of
// these responses is checked against the pin before the client sees it, for
// the whole session: checking only mcp-pin's own listing at connect let a
// server show mcp-pin one toolset and the client another.
const WATCHED = new Set(['tools/list', 'prompts/list', 'server/discover']);

function isRequest(m) {
  return !!m && typeof m.method === 'string' && m.id !== undefined && m.id !== null;
}

function isResponse(m) {
  return !!m && m.method === undefined && m.id !== undefined && ('result' in m || 'error' in m);
}

function idKey(v) {
  return typeof v + ':' + String(v);
}

// The protocol fields of a modern request, replayed on mcp-pin's own requests
// so the server answers them exactly as it answers the client.
function modernMeta(m) {
  const meta = m && m.params && m.params._meta;
  if (!meta || typeof meta[PV] !== 'string') return null;
  const out = { [PV]: meta[PV], [CC]: meta[CC] || {} };
  if (meta[CI]) out[CI] = meta[CI];
  return out;
}

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

  // A team lockfile, when given, is the pin: what the project approved in
  // review, rather than whatever this machine saw first. Unreadable or
  // tampered locks fail closed.
  const lockFlag = flags.indexOf('--lock') !== -1 ? flags[flags.indexOf('--lock') + 1] : null;
  if (flags.includes('--only-locked') && !lockFlag) {
    process.stderr.write('mcp-pin: --only-locked needs --lock <file>; not starting the server\n');
    process.exit(1);
  }
  let lockPin = null;
  let lockEntry = null;
  if (lockFlag) {
    const lf = require('../src/lockfile');
    try {
      lockEntry = lf.findEntry(lf.readLock(path.resolve(lockFlag)), nameFlag, id);
      if (lockEntry) lockPin = lf.asPin(lockEntry);
      else if (flags.includes('--only-locked')) {
        // An organisation's policy: only servers the lock approved may run.
        process.stderr.write(`mcp-pin: not starting ${label}: it is not in ${lockFlag}, and --only-locked runs only servers the lock approved\n`);
        process.exit(1);
      }
      else process.stderr.write(C.dim(`mcp-pin: ${label} is not in ${lockFlag}; using this machine's pin\n`));
    } catch (e) {
      process.stderr.write('mcp-pin: cannot use the lockfile ' + path.resolve(lockFlag) + ': ' + e.message + '\n' +
        (path.isAbsolute(lockFlag) ? '' : '  A relative path is read from the folder your client started this server in (' + process.cwd() + '). If that is not the project folder, give an absolute path.\n'));
      process.exit(1);
    }
  }

  // The package the lock approved runs, not whatever is newest today.
  let runArgs = args;
  if (lockEntry) {
    try {
      const run = require('../src/lockfile').lockedRun(lockEntry, command, args);
      runArgs = run.args;
      if (run.note) process.stderr.write(C.dim('mcp-pin: ' + run.note + '\n'));
    } catch (e) {
      process.stderr.write(`mcp-pin: not starting ${label}: ${e.message}\n`);
      process.exit(1);
    }
  }

  const child = spawnServer(command, runArgs, { stdio: ['pipe', 'pipe', 'inherit'] });
  child.on('error', (e) => {
    process.stderr.write(`mcp-pin: cannot start server: ${e.message}\n`);
    process.exit(127);
  });
  child.stdin.on('error', () => {});

  const INIT = 'INIT', VERIFYING = 'VERIFYING', RELEASED = 'RELEASED', BLOCKED = 'BLOCKED';
  let state = INIT;
  let era = null;              // 'legacy' or 'modern', decided by how the client opens
  let meta = null;             // the client's protocol _meta, for mcp-pin's own modern requests
  let pinned = null;           // the pin as verified at connect; listings are checked against it
  let blockedReply = null;     // what every further client request gets once blocked
  let verifying = false;
  let probeSeq = 0;
  const inbound = [];          // client lines held until the server is verified
  const outbound = [];         // server lines held until the server is verified
  const held = [];             // server responses to client requests, held until verified
  const discovers = new Map(); // client server/discover probes forwarded before verification
  const watched = new Map();   // client request id -> method, for responses checked before delivery
  const pending = new Map();   // mcp-pin's own requests
  // A checked response that repeats a JSON member name could show the client
  // a copy the check never read (JSON.parse keeps the last; some parsers keep
  // the first), so it is never forwarded or pinned.
  const REPEATED = 'the server repeated a JSON member name in a response mcp-pin checks; clients can read such a response differently from the check';

  function sendToServer(obj) {
    child.stdin.write(JSON.stringify(obj) + '\n');
  }

  function writeClient(line) {
    process.stdout.write(line + '\n');
  }

  function replyError(rid, err) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: rid, error: err }) + '\n');
  }

  function rejectAll(err) {
    for (const [, p] of pending) p.reject(err);
    pending.clear();
  }

  function sendRequest(method, params) {
    const rid = 'mcp-pin-' + process.pid + '-' + (++probeSeq);
    if (era === 'modern') params = Object.assign({}, params, { _meta: Object.assign({}, meta) });
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

  // Forward a client line to the server, remembering requests whose
  // responses must be checked before the client sees them.
  function forward(line, msg) {
    if (isRequest(msg) && WATCHED.has(msg.method)) watched.set(idKey(msg.id), msg.method);
    child.stdin.write(line + '\n');
  }

  function flushInbound() {
    for (const line of inbound) {
      let msg = null;
      try { msg = JSON.parse(line); } catch {}
      // mcp-pin already sent its own; a second one would confuse a legacy server.
      if (msg && msg.method === 'notifications/initialized') continue;
      forward(line, msg);
    }
    inbound.length = 0;
  }

  function release() {
    state = RELEASED;
    for (const h of held) writeClient(h.line);
    held.length = 0;
    for (const line of outbound) writeClient(line);
    outbound.length = 0;
    flushInbound();
  }

  // Request ids the client is still waiting on: held responses and queued
  // requests that were never forwarded.
  function waitingIds(extra) {
    const seen = new Set();
    const ids = [];
    const add = (v) => {
      if (v === undefined || v === null || seen.has(idKey(v))) return;
      seen.add(idKey(v));
      ids.push(v);
    };
    for (const h of held) add(h.msg.id);
    for (const line of inbound) {
      let m = null;
      try { m = JSON.parse(line); } catch {}
      if (isRequest(m)) add(m.id);
    }
    for (const v of extra || []) add(v);
    return ids;
  }

  function exitAfterFlush(code) {
    let done = false;
    const exit = () => { if (!done) { done = true; process.exit(code); } };
    if (process.stdout.writableLength) process.stdout.once('drain', () => setTimeout(exit, 20));
    else setTimeout(exit, 50);
    setTimeout(exit, 2000);
  }

  // Stop: answer everything the client is waiting on so it shows a reason
  // instead of hanging. The answer never repeats the new definitions: that
  // text is the attack, and clients may pass error messages to the model.
  function halt(drift, when, extraIds) {
    const midSession = when === 'session';
    blockedReply = {
      code: BLOCKED_CODE,
      message: midSession
        ? `mcp-pin blocked "${label}": a definition changed during this session, so the response was not forwarded. Restart the server to review the change with: mcp-pin review ${id}`
        : lockPin
          ? `mcp-pin blocked "${label}": its definitions differ from the project's mcp-pin.lock, so nothing was forwarded. See what changed with: mcp-pin lock --check`
          : `mcp-pin blocked "${label}": its definitions changed since you approved them, so nothing was forwarded. Review the change in a terminal with: mcp-pin review ${id}`,
      // Label keys only: fixed strings, never the server's new text.
      data: {
        reason: 'definitions_changed', server: id, review: 'mcp-pin review ' + id,
        changes: summarize(drift).map((s) => ({ name: s.name, kinds: s.labels.map((l) => l.key) })),
      },
    };
    const ids = waitingIds(extraIds);
    state = BLOCKED;
    rejectAll(new Error('session blocked'));
    for (const rid of ids) replyError(rid, blockedReply);
    inbound.length = 0;
    outbound.length = 0;
    held.length = 0;

    const pin = (() => { try { return store.getPin(id); } catch { return null; } })();
    const toolsMoved = drift.some((d) => d.what === 'tool');
    const headline = midSession
      ? (toolsMoved ? 'TOOL DEFINITIONS CHANGED DURING THIS SESSION' : 'DEFINITIONS CHANGED DURING THIS SESSION')
      : (toolsMoved ? 'TOOL DEFINITIONS CHANGED SINCE YOU APPROVED THIS SERVER' : 'DEFINITIONS CHANGED SINCE YOU APPROVED THIS SERVER');
    const out = [
      '',
      C.bold(C.red('  ⛔ mcp-pin: ' + headline)),
      '',
      `  server: ${label}`,
      `  id:     ${id}`,
      `  pinned: ${lockPin ? lockFlag : pin && pin.pinned_at ? pin.pinned_at : 'unknown'}`,
      '',
      renderSummary(drift),
      '',
      renderDrift(drift),
      '',
    ];
    if (midSession) {
      out.push(
        C.bold('  This session is blocked. The changed response was not forwarded to your client.'),
        '  The server showed the approved definitions when it connected and changed them afterwards.',
        `  If you trust the change, restart the server and review it with:  ${C.bold('mcp-pin review ' + id)}`,
        ''
      );
    } else if (lockPin) {
      out.push(
        C.bold('  This session is blocked. Nothing queued was forwarded to the server.'),
        '  These definitions differ from what the project approved in mcp-pin.lock.',
        `  If the change is expected, update the lock in a pull request so it is reviewed:  ${C.bold('mcp-pin lock')}`,
        ''
      );
    } else {
      out.push(
        C.bold('  This session is blocked. Nothing queued was forwarded to the server.'),
        `  Review the diff. If you accept it:  ${C.bold('mcp-pin approve ' + id)}`,
        `  Otherwise, do nothing and the pin stands.`,
        ''
      );
    }
    process.stderr.write(out.join('\n'));
    try { child.kill('SIGTERM'); } catch {}
    exitAfterFlush(42);
  }

  function unverified(e, extraIds, when) {
    const corrupt = e && e.name === 'CorruptStateError';
    // The client may show this to the model, so a server's own error text
    // is never repeated in it; mcp-pin's own reasons are fixed strings.
    const reason = e && e.rpc ? 'the server answered the check with an error' : e && e.message;
    const reply = {
      code: UNVERIFIED_CODE,
      message: corrupt
        ? `mcp-pin could not read its pin store, so "${label}" was not started. See the message in the server log.`
        : when === 'session'
          ? `mcp-pin stopped "${label}" (${reason}); the response was not forwarded.`
          : `mcp-pin could not verify "${label}" (${reason}), so nothing was forwarded.`,
    };
    const ids = waitingIds(extraIds);
    state = BLOCKED;
    blockedReply = reply;
    rejectAll(new Error('session blocked'));
    for (const rid of ids) replyError(rid, reply);
    inbound.length = 0;
    outbound.length = 0;
    held.length = 0;
    if (corrupt) {
      process.stderr.write('mcp-pin: corrupt state at ' + e.path + '\n');
      process.stderr.write(
        'The store could not be read. Restore this file from backup or remove it.\n' +
          'mcp-pin will not start until the store is readable.\n'
      );
    } else {
      process.stderr.write('mcp-pin: verification failed: ' + visible(e && e.message) + '\n');
    }
    try { child.kill('SIGTERM'); } catch {}
    exitAfterFlush(1);
  }

  // A modern request arrived before any server/discover result, and the
  // server would not answer mcp-pin's own probe. Give the client the answer
  // the server gave; nothing the client asked for was forwarded.
  function backToInit(err) {
    for (const rid of waitingIds()) replyError(rid, err);
    inbound.length = 0;
    state = INIT;
    verifying = false;
    era = null;
    meta = null;
  }

  function check(obs) {
    if (lockPin) {
      const drift = diffDefinitions(lockPin, obs);
      if (!drift.length) {
        process.stderr.write(C.dim(`mcp-pin: ${obs.tools.length} tool(s) match ${lockFlag} (${obs.setHash.slice(0, 12)})\n`));
        return { blocked: false, pin: lockPin };
      }
      store.append(Object.assign({ type: 'drift', server_id: id, label, against: 'lockfile', prev_set_hash: lockPin.setHash }, logDefinitions(obs)));
      return { blocked: true, drift };
    }

    const pin = store.getPin(id);

    if (!pin) {
      store.append(Object.assign({ type: 'pin', server_id: id, label }, logDefinitions(obs)));
      const rec = pinRecord(id, label, obs, definitionFields(obs));
      store.setPin(id, rec);
      const np = obs.prompts ? obs.prompts.length : 0;
      process.stderr.write(C.dim(
        `mcp-pin: pinned ${obs.tools.length} tool(s)` + (np ? ` and ${np} prompt(s)` : '') +
          ` for ${label} (${obs.setHash.slice(0, 12)})\n`
      ));
      return { blocked: false, pin: rec };
    }

    const drift = diffDefinitions(pin, obs);
    if (!drift.length) {
      const add = {};
      if (pin.prompts === undefined && obs.prompts !== undefined) {
        add.promptsHash = obs.promptsHash;
        add.prompts = obs.prompts;
      }
      if (pin.instructionsHash === undefined) {
        add.instructionsHash = obs.instructionsHash;
        add.instructions = obs.instructions;
      }
      let rec = pin;
      if (Object.keys(add).length) {
        rec = Object.assign({}, pin, add);
        store.append({
          type: 'extend', server_id: id, label,
          prompts_hash: add.promptsHash, instructions_hash: add.instructionsHash,
        });
        store.setPin(id, rec);
      }
      process.stderr.write(C.dim(`mcp-pin: ${obs.tools.length} tool(s) unchanged (${obs.setHash.slice(0, 12)})\n`));
      return { blocked: false, pin: rec };
    }

    store.append(Object.assign({ type: 'drift', server_id: id, label, prev_set_hash: pin.setHash }, logDefinitions(obs)));
    store.setPin(id, Object.assign({}, pin, {
      pending: Object.assign({ setHash: obs.setHash, tools: obs.tools }, definitionFields(obs), {
        observed_at: new Date().toISOString(),
      }),
    }));
    return { blocked: true, drift };
  }

  // A listing the client asked for, checked item by item against the pin
  // before it is delivered. Pages are checked as they arrive, so a changed
  // or added definition never reaches the client.
  function checkListing(method, result) {
    if (!pinned || !result || typeof result !== 'object') return [];
    const page = (pinList, items, what) => {
      const by = new Map((pinList || []).map((t) => [t.name, t]));
      const out = [];
      for (const item of items) {
        const f = fingerprintTool(item);
        const o = by.get(f.name);
        if (!o) out.push({ kind: 'added', what, name: f.name });
        else if (o.hash !== f.hash) out.push({ kind: 'changed', what, name: f.name, oldCanonical: o.canonical, newCanonical: f.canonical });
      }
      return out;
    };
    if (method === 'tools/list' && Array.isArray(result.tools)) return page(pinned.tools, result.tools, 'tool');
    if (method === 'prompts/list' && Array.isArray(result.prompts) && pinned.prompts !== undefined) {
      return page(pinned.prompts, result.prompts, 'prompt');
    }
    if (method === 'server/discover' && pinned.instructionsHash !== undefined) {
      const text = typeof result.instructions === 'string' ? result.instructions : null;
      if ((text === null ? null : sha256(text)) !== pinned.instructionsHash) {
        return [{ kind: 'instructions', oldText: pinned.instructions, newText: text }];
      }
    }
    return [];
  }

  async function startVerify(mode, clientMeta, first) {
    if (verifying) return;
    verifying = true;
    state = VERIFYING;
    era = mode;
    meta = clientMeta;
    try {
      // The initialize result (legacy) or the DiscoverResult (modern) carries
      // the server's capabilities and its instructions to the model.
      let info = first ? first.msg.result : null;
      if (mode === 'legacy') {
        sendToServer({ jsonrpc: '2.0', method: 'notifications/initialized' });
      } else if (!info) {
        try {
          info = await sendRequest('server/discover');
        } catch (e) {
          if (!e.rpc && !/timed out/.test(e.message)) throw e;
          backToInit(e.rpc || { code: UNVERIFIED_CODE, message: 'mcp-pin: the server did not answer server/discover' });
          return;
        }
      }
      const tools = await collectAllTools(sendRequest);
      const caps = (info && info.capabilities) || {};
      let prompts = [];
      if (caps.prompts) {
        // Unknown, not empty: a server that will not list its prompts leaves
        // any prompt pin as it stands.
        try { prompts = await collectAllPrompts(sendRequest); } catch { prompts = undefined; }
      }
      const instructions = info && typeof info.instructions === 'string' ? info.instructions : null;
      const verdict = check(observe(tools, prompts, instructions));
      if (verdict.blocked) {
        halt(verdict.drift, 'connect');
        return;
      }
      pinned = verdict.pin;
      release();
    } catch (e) {
      unverified(e);
    }
  }

  const fromClient = readline.createInterface({ input: process.stdin });
  // The client closing stdin is the stdio shutdown signal. Pass it on so the
  // server can exit, and the proxy exits with it.
  fromClient.on('close', () => {
    if (state !== BLOCKED) { try { child.stdin.end(); } catch {} }
  });
  fromClient.on('line', (line) => {
    let msg = null;
    try { msg = JSON.parse(line); } catch {}
    if (state === BLOCKED) {
      if (isRequest(msg) && blockedReply) replyError(msg.id, blockedReply);
      return;
    }
    if (state === RELEASED) {
      forward(line, msg);
      return;
    }
    if (state === INIT && isRequest(msg)) {
      if (msg.method === 'initialize') {
        era = 'legacy';
        sendToServer(msg);
        return;
      }
      const m = modernMeta(msg);
      if (m && msg.method === 'server/discover') {
        // A modern client's opening probe. Forward it: its answer decides the
        // era, and a legacy server's error must reach the client promptly so
        // it can fall back to initialize instead of waiting out a timeout.
        discovers.set(idKey(msg.id), msg);
        child.stdin.write(line + '\n');
        return;
      }
      if (m) {
        // A modern request with no probe first: verify with the client's own
        // metadata before anything reaches the server.
        inbound.push(line);
        startVerify('modern', m, null);
        return;
      }
    }
    inbound.push(line);
  });

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (state === BLOCKED) return;
    let msg = null;
    try { msg = JSON.parse(line); } catch {}
    if (!msg) {
      if (state === RELEASED) writeClient(line);
      else outbound.push(line);
      return;
    }

    if (isResponse(msg) && typeof msg.id === 'string' && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message || 'rpc error');
        err.rpc = msg.error;
        p.reject(err);
      } else if (msg.result === undefined) {
        p.reject(new Error('malformed rpc result'));
      } else if (repeatsMemberName(line)) {
        p.reject(new Error(REPEATED));
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    if (state === RELEASED) {
      if (isResponse(msg)) {
        const k = idKey(msg.id);
        const method = watched.get(k);
        if (method) {
          watched.delete(k);
          if (repeatsMemberName(line)) {
            unverified(new Error(REPEATED), [msg.id], 'session');
            return;
          }
          const drift = msg.result ? checkListing(method, msg.result) : [];
          if (drift.length) {
            try {
              store.append({
                type: 'drift', server_id: id, label, mid_session: true, method,
                changed: drift.map((d) => d.what + ':' + (d.name || 'instructions')),
              });
            } catch {}
            halt(drift, 'session', [msg.id]);
            return;
          }
        }
      }
      writeClient(line);
      return;
    }

    if (isResponse(msg) && discovers.has(idKey(msg.id))) {
      const req = discovers.get(idKey(msg.id));
      discovers.delete(idKey(msg.id));
      if (msg.result && repeatsMemberName(line)) {
        unverified(new Error(REPEATED), [msg.id]);
        return;
      }
      if (msg.result && state === INIT) {
        held.push({ msg, line });
        startVerify('modern', modernMeta(req), { msg });
      } else if (msg.result) {
        held.push({ msg, line });
      } else {
        // A legacy server, or a version this server does not speak. Either
        // way the client decides what to try next.
        writeClient(line);
      }
      return;
    }

    if (state === INIT && era === 'legacy' && isResponse(msg)) {
      if (msg.result && msg.result.protocolVersion) {
        if (repeatsMemberName(line)) {
          unverified(new Error(REPEATED), [msg.id]);
          return;
        }
        held.push({ msg, line });
        startVerify('legacy', null, { msg });
        return;
      }
      if (msg.error) {
        // The server refused initialize. Nothing to verify; the client sees why.
        writeClient(line);
        return;
      }
    }

    outbound.push(line);
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
  for (const t of p.tools) process.stdout.write(`  ${t.hash.slice(0, 16)}  ${visible(t.name)}\n`);
  for (const t of p.prompts || []) process.stdout.write(`  ${t.hash.slice(0, 16)}  prompt ${visible(t.name)}\n`);
  if (p.instructionsHash) process.stdout.write(`  ${p.instructionsHash.slice(0, 16)}  server instructions\n`);
  if (p.pending) process.stdout.write(`\nA change is waiting for review: mcp-pin review ${k}\n`);
}

function cmdReview(k) {
  const p = k && store.getPin(k);
  if (!p) { process.stderr.write('unknown server id\n'); process.exit(1); }
  if (!p.pending) { process.stdout.write(`nothing pending for ${p.label}\n`); return; }
  const drift = diffDefinitions(p, p.pending);
  process.stdout.write(`${p.label}\napproved  ${p.pinned_at}\nobserved  ${p.pending.observed_at}\n\n`);
  process.stdout.write(drift.length
    ? renderSummary(drift) + '\n\n' + renderDrift(drift) + '\n\n'
    : 'No difference from what you approved.\n\n');
  process.stdout.write(`If you accept this change:  mcp-pin approve ${k}\nOtherwise, do nothing and the pin stands.\n`);
}

function cmdApprove(k) {
  const p = k && store.getPin(k);
  if (!p) { process.stderr.write('unknown server id\n'); process.exit(1); }
  if (!p.pending) { process.stdout.write('nothing pending\n'); return; }
  store.append({ type: 'approve', server_id: k, label: p.label, set_hash: p.pending.setHash });
  // Prompts and instructions come from the change under review where it saw
  // them; otherwise they stay as approved before.
  const fields = Object.assign(definitionFields(p), definitionFields(p.pending));
  store.setPin(k, pinRecord(p.id || k, p.label, { setHash: p.pending.setHash, tools: p.pending.tools }, fields));
  process.stdout.write(`re-pinned ${p.label} at ${p.pending.setHash.slice(0, 12)}\n`);
}

function cmdWrap(mode) {
  const w = require('../src/wrap');
  const opts = argv.slice(1);
  const say = (s) => process.stdout.write(s + '\n');
  const targets = w.knownClients();
  for (let i = 0; i < opts.length; i++) {
    if (opts[i] === '--config' && opts[i + 1]) targets.push({ name: 'Config', file: path.resolve(opts[++i]) });
  }
  // Project files are shared with teammates through the repo, so only on
  // request. With --lock, every teammate's proxy checks the committed lock.
  const lockArg = mode === 'wrap' && opts.includes('--lock') ? opts[opts.indexOf('--lock') + 1] : null;
  if (lockArg) {
    if (!opts.includes('--project')) { say('--lock is for the project\'s shared .mcp.json: add --project.'); process.exitCode = 1; return; }
    try { require('../src/lockfile').readLock(path.resolve(lockArg)); } catch (e) {
      say(`Cannot use ${lockArg} (${e.code === 'ENOENT' ? 'not found' : e.message}). Write it first with: mcp-pin lock`);
      process.exitCode = 1;
      return;
    }
  }
  if (opts.includes('--project')) targets.push({ name: 'This project', file: path.resolve('.mcp.json'), extra: lockArg ? ['--lock', lockArg] : [] });

  const work = [];
  let found = 0;
  for (const c of targets) {
    const r = w.processFile(c.file, mode, c.extra);
    if (r === null) continue;
    found++;
    if (r.error) { say(`${c.name}  ${c.file}\n  not changed: ${r.error}`); continue; }
    if (!r.changes.length && !r.skipped.length) continue;
    say(`${c.name}  ${c.file}`);
    for (const ch of r.changes) {
      const where = ch.where.startsWith('project ') ? `  (${ch.where})` : '';
      say(`  ${mode === 'wrap' ? '+ protect  ' : '- unprotect'}  ${ch.name}${where}`);
      if (mode === 'wrap' && ch.pkg && !ch.pkg.pinned) say('               ' + require('../src/package').describe(ch.pkg));
    }
    for (const s of r.skipped) say(`    ${s.name}: ${s.reason}`);
    if (r.changes.length) work.push({ c, r });
  }

  if (!found) {
    say('No MCP config found for ' + w.knownClients().map((c) => c.name).join(', ') + '.');
    say('Point at another one with: mcp-pin ' + mode + ' --config <file>');
    return;
  }
  const n = work.reduce((a, x) => a + x.r.changes.length, 0);
  if (!n) {
    say(mode === 'wrap' ? 'Nothing to change: every local server found is already protected.' : 'Nothing to unwrap.');
    return;
  }
  if (opts.includes('--dry-run')) { say('\nDry run: nothing written.'); return; }

  const apply = () => {
    const backups = path.join(store.HOME, 'backups');
    for (const { c, r } of work) {
      const b = w.backupAndWrite(c.file, r.text, backups);
      say(`  wrote ${c.file}\n  backup ${b}`);
    }
    if (mode === 'wrap') {
      say(`\nRestart those apps so they load the change. The first start fetches ${w.PKG} once.`);
      say(`If your organisation allowlists MCP servers by command, the wrapped command is: npx -y ${w.PKG} --name <server> -- <original command>`);
      say('Undo any time with: mcp-pin unwrap');
    } else {
      say('\nRestart those apps so they load the change. Your pins stay in place; mcp-pin wrap puts protection back.');
    }
  };

  const verb = mode === 'wrap' ? 'Protect' : 'Unprotect';
  if (opts.includes('--yes')) return apply();
  if (!process.stdin.isTTY) { say('\nNothing written. Run again with --yes to apply.'); return; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(`\n${verb} ${n} server(s)? Each file is backed up first. [y/N] `, (ans) => {
    rl.close();
    if (/^y/i.test(ans.trim())) apply();
    else say('Nothing written.');
  });
}

// Admin policy that requires mcp-pin, from the servers in an approved config.
// Written to a folder for review; deploying it is the admin's step.
function cmdPolicy(product) {
  const policy = require('../src/policy');
  const opts = argv.slice(2);
  const val = (flag, dflt) => { const i = opts.indexOf(flag); return i !== -1 && opts[i + 1] ? opts[i + 1] : dflt; };
  const say = (s) => process.stdout.write(s + '\n');
  const products = product === 'all' ? policy.PRODUCTS : [product];
  if (!products.every((p) => policy.PRODUCTS.includes(p))) {
    say(`usage: mcp-pin policy <${policy.PRODUCTS.join('|')}|all> [--config .mcp.json] [--lock <absolute path>] [--out mcp-pin-policy]`);
    process.exitCode = 1;
    return;
  }
  const config = path.resolve(val('--config', '.mcp.json'));
  const lock = val('--lock', null);
  if (lock && !path.isAbsolute(lock) && !/^[A-Za-z]:\\/.test(lock)) {
    say('--lock needs the absolute path the lock will have on each machine, such as /etc/claude-code/mcp-pin.lock: managed servers do not start in a project folder.');
    process.exitCode = 1;
    return;
  }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(config, 'utf8')); } catch (e) {
    say(`Cannot read ${config}: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const map = doc.mcpServers || doc.servers || {};
  const n = Object.keys(map).length;
  for (const p of products) {
    const r = policy.generate(p, map, { lock });
    const out = path.resolve(val('--out', 'mcp-pin-policy'), p);
    fs.mkdirSync(out, { recursive: true });
    for (const [file, body] of Object.entries(r.files)) fs.writeFileSync(path.join(out, file), body);
    say(`${p}: wrote ${Object.keys(r.files).join(', ')} for ${n} server(s) to ${out}`);
    for (const line of r.deploy) say('  ' + line);
    for (const note of r.notes) say('  ' + note);
    say('');
  }
  if (lock) say(`Deploy the lock at ${lock} on every machine as well. Each wrapped server checks it, and with --only-locked a server it does not list does not start.`);
  say('These match each wrapped command exactly, so regenerate them when the approved list or the mcp-pin version changes. Deploying them is your step: nothing here is installed.');
}

async function cmdLock() {
  const lf = require('../src/lockfile');
  const opts = argv.slice(1);
  const val = (flag, dflt) => { const i = opts.indexOf(flag); return i !== -1 && opts[i + 1] ? opts[i + 1] : dflt; };
  const config = path.resolve(val('--config', '.mcp.json'));
  const out = path.resolve(val('--out', 'mcp-pin.lock'));
  const check = opts.includes('--check');
  const say = (s) => process.stdout.write(s + '\n');

  const servers = lf.serversFrom(config);
  const lock = fs.existsSync(out) ? lf.readLock(out) : null;
  if (check && !lock) throw new Error('no lockfile at ' + out + '; write one with: mcp-pin lock');
  if (!servers.length) { say('No local (stdio) MCP servers in ' + config + '.'); return; }

  const pk = require('../src/package');
  const packages = !opts.includes('--definitions-only');
  const next = {};
  let changed = 0;
  let failed = 0;
  let held = 0;
  for (const s of servers) {
    const prev = lock && lock.servers[s.name];
    const was = prev && prev.package;
    const notes = [];

    // The package first: the exact version to probe and record. When the
    // config asks for the newest, the lock holds the project at the version
    // it reviewed; lock --check probes that version, which is what runs.
    let pkgRec = null;
    let probeArgs = s.args;
    const pkg = packages ? s.pkg : null;
    if (pkg && pkg.ecosystem === 'oci') {
      pkgRec = lf.packageRecord(pkg);
      if (!pkg.pinned) notes.push(`image ${pkg.name} is not pinned by digest, so it can change on any start`);
    } else if (pkg) {
      const hold = check && was && was.version && !pkg.pinned ? pk.pinnedArgs(s.args, pkg, was.version) : null;
      let now;      // the newest version the spec resolves to
      let runs;     // the registry's view of the version that actually runs
      try {
        now = await pk.resolve(pkg);
        runs = hold && was.version !== now.version ? await pk.resolve(Object.assign({}, pkg, { version: was.version, pinned: true })) : now;
      } catch (e) {
        failed++;
        say(`${s.name}: could not check its package ${pkg.name} (${visible(e.message)})`);
        if (prev) next[s.name] = prev;
        continue;
      }
      if (prev && !was && check) {
        changed++;
        notes.push(`its package is not recorded in the lock yet; run mcp-pin lock`);
      }
      if (was && was.version === runs.version && !lf.sameContents(was, runs)) {
        changed++;
        notes.push(`the registry now serves different contents for ${pkg.name} ${runs.version} than when it was locked`);
      }
      if (was && was.version && was.version !== now.version) {
        if (hold) notes.push(`${pkg.name} ${now.version} is out; this project keeps running ${was.version} until the lock is updated (mcp-pin lock)`);
        else if (check) { changed++; notes.push(`${pkg.name} moved from ${was.version} to ${now.version}, and this form of command cannot be held back`); }
        else notes.push(`${pkg.name} ${was.version} to ${now.version}`);
      }
      if (hold) { probeArgs = hold; pkgRec = was; }
      else {
        probeArgs = pkg.pinned ? s.args : (pk.pinnedArgs(s.args, pkg, now.version) || s.args);
        pkgRec = lf.packageRecord(pkg, now);
      }
      if (!pkg.pinned && pk.pinnedArgs(s.args, pkg, now.version)) held++;
    }

    let obs;
    try {
      obs = await lf.probeDefinitions(s.command, probeArgs, s.env);
    } catch (e) {
      failed++;
      say(`${s.name}: could not start (${visible(e.message)})`);
      if (prev) next[s.name] = prev;
      continue;
    }
    let prevPin = null;
    try { prevPin = prev ? lf.asPin(prev) : null; } catch (e) { prevPin = e; }
    const pkgText = pkgRec && pkgRec.version ? `, ${pkgRec.name} ${pkgRec.ecosystem === 'oci' ? pkgRec.version.slice(0, 19) : pkgRec.version}` : '';
    if (!prev) {
      if (check) changed++;
      say(`${s.name}: ${check ? 'not in the lock' : 'locked'} (${obs.tools.length} tool(s)${pkgText})`);
    } else if (prevPin instanceof Error) {
      changed++;
      say(`${s.name}: its entry in the lock is not valid: ${prevPin.message}${check ? '' : '. Rewritten from what the server serves now.'}`);
    } else {
      const drift = diffDefinitions(prevPin, obs);
      if (prevPin.id !== s.id) { changed++; say(`${s.name}: its command in ${path.basename(config)} changed since it was locked`); }
      else if (drift.length) { changed++; say(`${s.name}: changed since it was locked`); }
      else say(`${s.name}: matches the lock${pkgText ? ` (${pkgText.slice(2)})` : ''}`);
      if (drift.length) say(renderSummary(drift));
    }
    for (const n of notes) say('  ' + n);
    next[s.name] = lf.toEntry(s, obs, pkgRec);
  }
  if (lock) {
    for (const name of Object.keys(lock.servers)) {
      if (!servers.some((s) => s.name === name)) { changed++; say(`${name}: in the lock but no longer in ${path.basename(config)}`); }
    }
  }

  if (check) {
    if (changed || failed) {
      say(`\n${changed} server(s) differ from ${path.basename(out)}${failed ? `, ${failed} could not start` : ''}.`);
      say('If the change is expected, run mcp-pin lock and commit the updated lockfile in a pull request.');
      process.exit(1);
    }
    say(`\nAll ${servers.length} server(s) match ${path.basename(out)}.`);
    return;
  }
  lf.writeLock(out, next);
  say(`\nwrote ${out}`);
  say('Commit it. A pull request that changes a server now shows exactly what its tools tell the model.');
  say(`Pin each teammate's proxy to it: mcp-pin wrap --project --lock ${path.basename(out)}`);
  if (held) say(`${held} server(s) run the newest version of a package; with the lock they stay at the version recorded here until the lock is updated.`);
  if (failed) process.exit(1);
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
  if (r.ok && !r.exists) process.stdout.write('no local log yet\n');
  else if (r.ok) process.stdout.write(`log ok, ${r.count} entries, chain intact\n`);
  else { process.stderr.write(`log BROKEN at entry ${r.index}: ${r.reason}\n`); process.exit(1); }
}
