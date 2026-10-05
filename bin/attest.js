#!/usr/bin/env node
'use strict';
/*
 * mcp-pin. Pin the tools your agent was introduced to, and re-derive that
 * decision on every connect.
 *
 * usage:  npx mcp-pin -- <server command> [args...]
 *         npx mcp-pin list | show <id> | review <id> | approve <id> | forget <id> | verify
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { fingerprintToolset, fingerprintTool, sha256 } = require('../src/canonical');
const store = require('../src/store');
const { collectAllTools, collectAllPrompts } = require('../src/list-tools');
const { renderDrift, renderSummary, C } = require('../src/diff');
const { summarize } = require('../src/classify');

const argv = process.argv.slice(2);

function usage(code) {
  process.stderr.write(
    `mcp-pin, tool-integrity pinning for MCP\n\n` +
      `  mcp-pin -- <server command> [args...]   run a server behind the proxy\n` +
      `  mcp-pin wrap                            protect every local MCP server in your AI apps\n` +
      `  mcp-pin unwrap                          take mcp-pin out of those configs again\n` +
      `  mcp-pin list                            pinned servers\n` +
      `  mcp-pin show <id>                       pinned tool fingerprints\n` +
      `  mcp-pin review <id>                     show what changed since you approved it\n` +
      `  mcp-pin approve <id>                    accept the last observed drift\n` +
      `  mcp-pin forget <id>                     drop a pin (re-pins on next run)\n` +
      `  mcp-pin verify                          verify the local log chain\n` +
      `  mcp-pin demo                            watch a changed tool get blocked (10 s)\n\n` +
      `  --name <label>   friendly name for this server\n` +
      `  --yes            auto-approve first pin only (never approves drift)\n\n` +
      `  wrap / unwrap:  --yes apply without asking   --dry-run show only\n` +
      `                  --config <file> another config   --project also ./.mcp.json\n`
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

// Everything the model reads from a server, observed in one place.
function observe(tools, prompts, instructions) {
  const fp = fingerprintToolset(tools);
  const out = { setHash: fp.setHash, tools: fp.tools };
  if (prompts) {
    const pp = fingerprintToolset(prompts);
    out.promptsHash = pp.setHash;
    out.prompts = pp.tools;
  }
  out.instructions = instructions;
  out.instructionsHash = instructions === null ? null : sha256(instructions);
  return out;
}

function diffNamed(pinned, observed, what) {
  const oldBy = new Map((pinned || []).map((t) => [t.name, t]));
  const newBy = new Map((observed || []).map((t) => [t.name, t]));
  const out = [];
  for (const [name, t] of newBy) {
    const o = oldBy.get(name);
    if (!o) out.push({ kind: 'added', what, name });
    else if (o.hash !== t.hash) out.push({ kind: 'changed', what, name, oldCanonical: o.canonical, newCanonical: t.canonical });
  }
  for (const name of oldBy.keys()) if (!newBy.has(name)) out.push({ kind: 'removed', what, name });
  return out;
}

// Pins made by 0.1.4 and earlier cover tools only; their prompts and
// instructions fields are undefined and are recorded on the next clean connect.
function diffDefinitions(pin, obs) {
  const drift = [];
  if (pin.setHash !== obs.setHash) drift.push(...diffNamed(pin.tools, obs.tools, 'tool'));
  if (pin.prompts !== undefined && obs.prompts !== undefined && pin.promptsHash !== obs.promptsHash) {
    drift.push(...diffNamed(pin.prompts, obs.prompts, 'prompt'));
  }
  if (pin.instructionsHash !== undefined && pin.instructionsHash !== obs.instructionsHash) {
    drift.push({ kind: 'instructions', oldText: pin.instructions, newText: obs.instructions });
  }
  return drift;
}

function definitionFields(src) {
  const out = {};
  for (const k of ['promptsHash', 'prompts', 'instructionsHash', 'instructions']) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

function logDefinitions(obs) {
  return {
    set_hash: obs.setHash,
    tools: obs.tools.map((t) => ({ name: t.name, hash: t.hash, canonical_json: t.canonical })),
    prompts: obs.prompts ? obs.prompts.map((t) => ({ name: t.name, hash: t.hash, canonical_json: t.canonical })) : undefined,
    instructions_hash: obs.instructionsHash,
  };
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

  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
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
      `  pinned: ${pin && pin.pinned_at ? pin.pinned_at : 'unknown'}`,
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

  function unverified(e) {
    const corrupt = e && e.name === 'CorruptStateError';
    const reply = {
      code: UNVERIFIED_CODE,
      message: corrupt
        ? `mcp-pin could not read its pin store, so "${label}" was not started. See the message in the server log.`
        : `mcp-pin could not verify "${label}" (${e && e.message}), so nothing was forwarded.`,
    };
    const ids = waitingIds();
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
      process.stderr.write('mcp-pin: verification failed: ' + (e && e.message) + '\n');
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
  for (const t of p.tools) process.stdout.write(`  ${t.hash.slice(0, 16)}  ${t.name}\n`);
  for (const t of p.prompts || []) process.stdout.write(`  ${t.hash.slice(0, 16)}  prompt ${t.name}\n`);
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
  // Project files are shared with teammates through the repo, so only on request.
  if (opts.includes('--project')) targets.push({ name: 'This project', file: path.resolve('.mcp.json') });

  const work = [];
  let found = 0;
  for (const c of targets) {
    const r = w.processFile(c.file, mode);
    if (r === null) continue;
    found++;
    if (r.error) { say(`${c.name}  ${c.file}\n  not changed: ${r.error}`); continue; }
    if (!r.changes.length && !r.skipped.length) continue;
    say(`${c.name}  ${c.file}`);
    for (const ch of r.changes) {
      const where = ch.where.startsWith('project ') ? `  (${ch.where})` : '';
      say(`  ${mode === 'wrap' ? '+ protect  ' : '- unprotect'}  ${ch.name}${where}`);
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
