'use strict';
/*
 * Probing. Given a discovered server, obtain its tools/list.
 *
 * SAFETY: probing a stdio server means downloading and executing an arbitrary
 * npm package. The crawler must run in a disposable sandbox (container, no
 * credentials mounted, no network beyond the registry, non-root, read-only
 * home). `--allow-exec` is required to enable stdio probing so that nobody
 * runs this on a laptop by accident. HTTP probing is safe and is the default.
 */
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const { fingerprintToolset } = require('../src/canonical');
const { collectAllTools } = require('../src/list-tools');
const { LIMITS, safeFetch, assertSafeUrl, validateToolset } = require('./security');

const PROTOCOL = '2025-06-18';

// Many servers exit immediately because a required credential env var is
// unset. They almost always name it. Detect it so we can retry with a
// placeholder, enough to reach tools/list, never enough to authenticate.
function detectMissingEnv(stderr) {
  const names = new Set();
  const pats = [
    /([A-Z][A-Z0-9_]{3,})\s*(?:environment variable\s*)?(?:is\s*)?(?:required|not set|missing|must be set)/g,
    /(?:missing|required|set)\s+(?:the\s+)?(?:env(?:ironment)?\s+var(?:iable)?\s+)?["'`]?([A-Z][A-Z0-9_]{3,})["'`]?/g,
    /process\.env\.([A-Z][A-Z0-9_]{3,})/g,
  ];
  for (const re of pats) { let m; while ((m = re.exec(stderr || ''))) names.add(m[1]); }
  return [...names].filter((n) => !['NODE_ENV', 'PATH', 'HOME', 'CI'].includes(n)).slice(0, 8);
}
const CLIENT_INFO = { name: 'mcp-pin-crawler', version: '0.1.1' };

function initMsg(id) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT_INFO },
  };
}

// ---------------------------------------------------------------- stdio

function probeStdio(install, { timeoutMs = 45000, env = {} } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(install.command, install.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        // Deliberately minimal. The child is untrusted code; it gets no tokens,
        // no cloud credentials, and no access to the operator's environment.
        env: Object.assign({ PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', CI: '1', NO_UPDATE_NOTIFIER: '1' }, env),
      });
    } catch (e) {
      return resolve({ ok: false, error: 'spawn: ' + e.message });
    }

    let errBuf = '';
    if (child.stderr) child.stderr.on('data', (d) => { if (errBuf.length < 4000) errBuf += d.toString(); });

    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
    const pending = new Map();
    let rpcId = 10;

    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
    child.on('exit', (code) => {
      for (const [, p] of pending) p.reject(new Error('exited ' + code));
      pending.clear();
      clearTimeout(timer);
      finish({ ok: false, error: 'exited ' + code, stderr: errBuf, missingEnv: detectMissingEnv(errBuf) });
    });
    function sendRequest(method, params) {
      const id = ++rpcId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const msg = { jsonrpc: '2.0', id, method };
        if (params !== undefined) msg.params = params;
        try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch (e) { pending.delete(id); reject(e); }
      });
    }

    let stdoutBytes = 0;
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      stdoutBytes += line.length;
      if (stdoutBytes > LIMITS.MAX_TOOLSET_BYTES) return finish({ ok: false, error: 'stdout flood' });
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.id === 1 && m.result) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        collectAllTools(sendRequest).then((tools) => {
          clearTimeout(timer);
          finish({ ok: true, tools });
        }).catch((e) => {
          clearTimeout(timer);
          finish({ ok: false, error: 'tools/list: ' + e.message });
        });
      } else if (m.id != null && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message || 'rpc error'));
        else if (!m.result) p.reject(new Error('malformed rpc result'));
        else p.resolve(m.result);
      }
    });

    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify(initMsg(1)) + '\n');
  });
}

// ----------------------------------------------------------------- http

// Streamable HTTP transport. Handles both a JSON response and an SSE stream,
// since servers differ on which they return for the same request.
async function postRPC(url, body, sessionId, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  try {
    const { res: r, text } = await safeFetch(url, { method: 'POST', headers, body: JSON.stringify(body) }, { timeoutMs, maxBytes: LIMITS.MAX_HTTP_BYTES });
    const sid = r.headers.get('mcp-session-id') || sessionId;
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) return { error: `${r.status}`, sid };
    if (ct.includes('text/event-stream')) {
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const j = JSON.parse(line.slice(5).trim());
          if (j.id === body.id) return { msg: j, sid };
        } catch {}
      }
      return { error: 'no matching sse frame', sid };
    }
    try { return { msg: JSON.parse(text), sid }; } catch { return { error: 'bad json', sid }; }
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : e.message, sid: sessionId };
  } finally {
    clearTimeout(t);
  }
}

async function probeHttp(install, { timeoutMs = LIMITS.HTTP_TIMEOUT_MS } = {}) {
  try { await assertSafeUrl(install.url); } catch (e) { return { ok: false, error: 'url rejected: ' + e.message }; }
  const init = await postRPC(install.url, initMsg(1), null, timeoutMs);
  if (init.error) return { ok: false, error: 'initialize: ' + init.error };
  const sid = init.sid;
  await postRPC(install.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid, 5000).catch(() => {});
  let rpcId = 1;
  try {
    const tools = await collectAllTools(async (method, params) => {
      const id = ++rpcId;
      const body = { jsonrpc: '2.0', id, method };
      if (params !== undefined) body.params = params;
      const list = await postRPC(install.url, body, sid, timeoutMs);
      if (list.error) throw new Error(list.error);
      if (list.msg && list.msg.error) throw new Error(list.msg.error.message || 'rpc error');
      if (!list.msg || list.msg.result == null) throw new Error('malformed tools/list');
      return list.msg.result;
    });
    return { ok: true, tools };
  } catch (e) {
    return { ok: false, error: 'tools/list: ' + e.message };
  }
}

// npx cold-resolves on every call, which is slow and times out under
// concurrency. Install once into a scratch prefix, then execute the bin
// directly. Returns the resolved executable spec, or null.
// npm's cache is not safe under heavy parallel installs; serialize them.
let installChain = Promise.resolve();
function installNpmQueued(pkg, root) {
  const run = installChain.then(() => installNpm(pkg, root));
  installChain = run.catch(() => {});
  return run;
}

function installNpm(pkg, root, timeoutMs = 180000) {
  const fs2 = require('fs');
  const os = require('os');
  const dir = path.join(root, pkg.replace(/[^a-z0-9]/gi, '_'));
  fs2.mkdirSync(dir, { recursive: true });
  const r = require('child_process').spawnSync(
    'npm',
    ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--prefix', dir, pkg],
    { timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] }
  );
  if (r.status !== 0) return { error: 'install failed: ' + String(r.stderr || '').split('\n')[0].slice(0, 120) };

  // Prefer a declared bin; fall back to main.
  let pkgDir = path.join(dir, 'node_modules', pkg);
  let manifest;
  try { manifest = JSON.parse(fs2.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')); } catch { return { error: 'no manifest' }; }
  let entry = null;
  if (typeof manifest.bin === 'string') entry = path.join(pkgDir, manifest.bin);
  else if (manifest.bin && typeof manifest.bin === 'object') entry = path.join(pkgDir, Object.values(manifest.bin)[0]);
  else if (manifest.main) entry = path.join(pkgDir, manifest.main);
  if (!entry || !fs2.existsSync(entry)) return { error: 'no executable entrypoint' };
  return { command: process.execPath, args: [entry], dir };
}


async function probe(server, opts = {}) {
  let install = server.install || {};
  let r;
  if (install.type === 'http') r = await probeHttp(install, opts);
  else if (install.type === 'stdio') {
    if (!opts.allowExec) return { ok: false, error: 'stdio probing disabled (needs --allow-exec in a sandbox)' };
    // Resolve npm packages to a local entrypoint first.
    if (install.command === 'npx' && opts.scratch) {
      const pkg = install.args[install.args.length - 1];
      const res = await installNpmQueued(pkg, opts.scratch);
      if (res.error) return { ok: false, error: res.error };
      install = { type: 'stdio', command: res.command, args: res.args };
    }
    r = await probeStdio(install, opts);
    // One retry with placeholder credentials if the server named what it needs.
    if (!r.ok && r.missingEnv && r.missingEnv.length) {
      const env = {};
      for (const n of r.missingEnv) env[n] = 'mcp-pin-probe-placeholder';
      const r2 = await probeStdio(install, Object.assign({}, opts, { env }));
      if (r2.ok) { r = r2; r.usedPlaceholderEnv = r.missingEnv; }
      else r.error = 'needs credentials (' + r.missingEnv.join(', ') + ')';
    }
  } else return { ok: false, error: 'unknown install type' };

  if (!r.ok) return r;
  const v = validateToolset(r.tools);
  if (!v.ok) return { ok: false, error: 'rejected: ' + v.error };
  const fp = fingerprintToolset(r.tools);
  return { ok: true, setHash: fp.setHash, tools: fp.tools, count: fp.tools.length };
}

module.exports = { probe, probeStdio, probeHttp, installNpm };
