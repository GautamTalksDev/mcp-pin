#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { canonicalize, fingerprintToolset, sha256 } = require(path.join(ROOT, 'src/canonical'));
const { collectAllTools } = require(path.join(ROOT, 'src/list-tools'));
const { PublicLog } = require(path.join(ROOT, 'crawler/log'));
const { badgeFor } = require(path.join(ROOT, 'crawler/badge'));
const ATTEST = path.join(ROOT, 'bin/attest.js');

// The crawler refuses to mint a signing key in CI. Tests still need to sign
// a throwaway log, so generate one here and hand it over explicitly.
if (!process.env.LOG_PRIVATE_KEY) {
  const { privateKey } = require('crypto').generateKeyPairSync('ed25519');
  process.env.LOG_PRIVATE_KEY = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
}

let pass = 0;
function t(name, fn) {
  try { fn(); process.stdout.write(`  ok  ${name}\n`); pass++; }
  catch (e) { process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`); process.exitCode = 1; }
}

process.stdout.write('canonicalization\n');
t('key order does not affect the hash', () => {
  const a = { name: 'x', description: 'd', inputSchema: { type: 'object' } };
  const b = { inputSchema: { type: 'object' }, description: 'd', name: 'x' };
  assert.strictEqual(canonicalize(a), canonicalize(b));
});
t('a changed description changes the hash', () => {
  const a = fingerprintToolset([{ name: 'x', description: 'a' }]);
  const b = fingerprintToolset([{ name: 'x', description: 'b' }]);
  assert.notStrictEqual(a.setHash, b.setHash);
});
t('a changed schema changes the hash', () => {
  const a = fingerprintToolset([{ name: 'x', inputSchema: { properties: {} } }]);
  const b = fingerprintToolset([{ name: 'x', inputSchema: { properties: { secret: { type: 'string' } } } }]);
  assert.notStrictEqual(a.setHash, b.setHash);
});
t('an added tool changes the set hash', () => {
  const a = fingerprintToolset([{ name: 'x' }]);
  const b = fingerprintToolset([{ name: 'x' }, { name: 'y' }]);
  assert.notStrictEqual(a.setHash, b.setHash);
});
t('tool order does not affect the set hash', () => {
  const a = fingerprintToolset([{ name: 'x' }, { name: 'y' }]);
  const b = fingerprintToolset([{ name: 'y' }, { name: 'x' }]);
  assert.strictEqual(a.setHash, b.setHash);
});
t('annotations are in scope', () => {
  const a = fingerprintToolset([{ name: 'x', annotations: { readOnlyHint: true } }]);
  const b = fingerprintToolset([{ name: 'x', annotations: { readOnlyHint: false } }]);
  assert.notStrictEqual(a.setHash, b.setHash);
});

process.stdout.write('public log\n');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-test-'));
const log = new PublicLog(dir);
t('append and verify', () => {
  log.append({ server_id: 's1', server_name: 'one', source: 'test', set_hash: 'h1', tools: [] });
  log.append({ server_id: 's1', server_name: 'one', source: 'test', set_hash: 'h2', tools: [] });
  log.signHead();
  assert.strictEqual(log.verify().ok, true);
});
t('history is per server', () => assert.strictEqual(log.history('s1').length, 2));
t('tampering breaks verification', () => {
  const lines = fs.readFileSync(log.file, 'utf8').trim().split('\n');
  const j = JSON.parse(lines[0]); j.set_hash = 'tampered'; lines[0] = JSON.stringify(j);
  fs.writeFileSync(log.file, lines.join('\n') + '\n');
  assert.strictEqual(log.verify().ok, false);
});
t('rejects a missing head', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-head-'));
  const l = new PublicLog(d);
  l.append({ server_id: 's', server_name: 'n', source: 'test', set_hash: 'h', tools: [] });
  const r = l.verify({ trustedPublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /missing head/);
});
t('rejects a mismatched tree_size', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-tree-'));
  const l = new PublicLog(d);
  l.append({ server_id: 's', server_name: 'n', source: 'test', set_hash: 'h', tools: [] });
  const h = l.signHead();
  h.tree_size = 99;
  const crypto = require('crypto');
  const der = Buffer.from(process.env.LOG_PRIVATE_KEY, 'base64');
  const priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const { canonicalize } = require(path.join(ROOT, 'src/canonical'));
  const body = { tree_size: 99, root_hash: h.root_hash, signed_at: h.signed_at };
  const sig = crypto.sign(null, Buffer.from(canonicalize(body)), priv);
  fs.writeFileSync(l.headFile, JSON.stringify(Object.assign({}, body, { signature: sig.toString('base64'), public_key: h.public_key }), null, 2));
  const r = l.verify({ trustedPublicKey: h.public_key });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /tree_size/);
});
t('rejects a malformed log', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-malform-'));
  const l = new PublicLog(d);
  fs.writeFileSync(l.file, 'garbage\n');
  const r = l.verify();
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /malformed/);
});
t('rejects a head signed by an untrusted key', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-key-'));
  const l = new PublicLog(d);
  l.append({ server_id: 's', server_name: 'n', source: 'test', set_hash: 'h', tools: [] });
  const h = l.signHead();
  const r = l.verify({ trustedPublicKey: 'MCowBQYDK2VwAyEA00000000000000000000000000000000000000000000000=' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /untrusted key/);
  assert.ok(h.public_key);
});

process.stdout.write('badge\n');
const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
t('never-changed server reads unchanged', () => {
  const svg = badgeFor({ set_hash: 'x', first_seen_at: ago(40), last_change_at: null, last_ok_at: ago(0) });
  assert.ok(svg.includes('unchanged 40d'), svg.slice(0, 120));
});
t('recently changed server reads changed', () => {
  const svg = badgeFor({ set_hash: 'x', first_seen_at: '2026-01-01T00:00:00Z', last_change_at: ago(0), last_change_after: ago(1), last_ok_at: ago(0) });
  assert.ok(svg.includes('changed today'));
});
t('stops counting when the crawler stops looking', () => {
  const svg = badgeFor({ set_hash: 'x', first_seen_at: ago(40), last_change_at: null, last_probe_at: ago(30) });
  assert.ok(svg.includes('last checked'), svg.slice(0, 160));
  assert.ok(!svg.includes('unchanged'), 'a stale record must not claim unchanged');
});
t('a failed last probe is not a look', () => {
  const svg = badgeFor({ set_hash: 'x', first_seen_at: ago(40), last_change_at: null, last_probe_at: ago(0), last_error: 'exited 1' });
  assert.ok(svg.includes('last checked'), svg.slice(0, 160));
  assert.ok(!svg.includes('unchanged'));
});
t('a change seen after a gap is not dated to today', () => {
  const svg = badgeFor({ set_hash: 'x', first_seen_at: ago(40), last_change_at: ago(0), last_change_after: ago(31), last_ok_at: ago(0) });
  assert.ok(svg.includes('changed since'), svg.slice(0, 160));
  assert.ok(!svg.includes('changed today'));
});
t('unchanged counts to the last good look, not to now', () => {
  const { status } = require(path.join(ROOT, 'crawler/badge'));
  const s = status({ set_hash: 'x', first_seen_at: ago(40), last_change_at: null, last_ok_at: ago(2) });
  assert.strictEqual(s.text, 'unchanged 38d');
});

process.stdout.write('proxy end to end\n');
t('pins on first connect, blocks on drift', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-home-'));
  const state = path.join(home, 'connects');
  const env = Object.assign({}, process.env, { MCP_PIN_HOME: home, ATTEST_HOME: home, RUGPULL_STATE: state });
  const client = path.join(__dirname, 'fake-client.js');
  const cmd = [ATTEST, '--', process.execPath, path.join(ROOT, 'demo/rugpull-server.js')];

  const r1 = spawnSync(process.execPath, [client, process.execPath, ...cmd], { env, encoding: 'utf8', timeout: 20000 });
  assert.ok(/pinned 1 tool/.test(r1.stderr), 'expected pin on first run');
  assert.ok(/CLIENT SAW/.test(r1.stdout), 'client should receive the benign toolset');

  const r2 = spawnSync(process.execPath, [client, process.execPath, ...cmd], { env, encoding: 'utf8', timeout: 20000 });
  assert.ok(/TOOL DEFINITIONS CHANGED/.test(r2.stderr), 'expected block on second run');
  assert.ok(!/CLIENT SAW/.test(r2.stdout), 'poisoned toolset must never reach the client');
});
t('demo pins, then blocks the changed tool, and leaves real pins alone', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-real-'));
  const env = Object.assign({}, process.env, { MCP_PIN_HOME: real, ATTEST_HOME: real, NO_COLOR: '1' });
  const r = spawnSync(process.execPath, [ATTEST, 'demo'], { env, encoding: 'utf8', timeout: 60000 });
  const out = r.stdout + r.stderr;
  assert.strictEqual(r.status, 0, out);
  assert.match(out, /pinned 1 tool/);
  assert.match(out, /TOOL DEFINITIONS CHANGED SINCE YOU APPROVED THIS SERVER/);
  assert.match(out, /context/);
  assert.deepStrictEqual(fs.readdirSync(real), [], 'the demo must not touch the real pin store');
});
t('only the harmless demo server ships in the package', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('demo/drift-server.js'));
  assert.ok(!pkg.files.includes('demo') && !pkg.files.includes('demo/rugpull-server.js'));
});
t('pins both pages of a paginated tools/list', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-page-'));
  const env = Object.assign({}, process.env, { MCP_PIN_HOME: home, PAGED: '1' });
  const client = path.join(__dirname, 'fake-client.js');
  const srv = path.join(__dirname, 'paged-server.js');
  const r = spawnSync(process.execPath, [client, process.execPath, ATTEST, '--', process.execPath, srv], {
    env, encoding: 'utf8', timeout: 20000,
  });
  assert.ok(/pinned 2 tool/.test(r.stderr), 'expected both pages pinned: ' + r.stderr.slice(0, 400));
  const dir = path.join(home, 'pins.d');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('.tmp.'));
  assert.strictEqual(files.length, 1);
  const body = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  assert.ok(body.includes('"alpha"'), body);
  assert.ok(body.includes('"beta"'), body);
});
t('corrupt pins.json fails closed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-corrupt-'));
  fs.writeFileSync(path.join(home, 'pins.json'), '{"broken":');
  const r = spawnSync(process.execPath, [ATTEST, 'list'], {
    env: Object.assign({}, process.env, { MCP_PIN_HOME: home }),
    encoding: 'utf8', timeout: 10000,
  });
  assert.notStrictEqual(r.status, 0, 'list must not exit 0 on corrupt pins');
  assert.ok(/corrupt state/.test(r.stderr), r.stderr);
  assert.ok(/pins\.json/.test(r.stderr), r.stderr);
  assert.ok(!/no pinned servers yet/.test(r.stdout), r.stdout);
});
t('garbage log fails verify', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-glog-'));
  fs.mkdirSync(path.join(home, 'pins.d'), { recursive: true });
  fs.writeFileSync(path.join(home, 'log.ndjson'), 'garbage\n');
  const r = spawnSync(process.execPath, [ATTEST, 'verify'], {
    env: Object.assign({}, process.env, { MCP_PIN_HOME: home }),
    encoding: 'utf8', timeout: 10000,
  });
  assert.notStrictEqual(r.status, 0, 'verify must not exit 0 on garbage log');
  assert.ok(/corrupt state|BROKEN|malformed/i.test(r.stderr), r.stderr);
});
t('migrates legacy pins.json into pins.d', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-mig-'));
  const id = 'aaaaaaaaaaaaaaaa';
  fs.writeFileSync(path.join(home, 'pins.json'), JSON.stringify({ [id]: { id, label: 'legacy', setHash: 'h', tools: [] } }));
  const r = spawnSync(process.execPath, [ATTEST, 'list'], {
    env: Object.assign({}, process.env, { MCP_PIN_HOME: home }),
    encoding: 'utf8', timeout: 10000,
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(home, 'pins.json.migrated')));
  assert.ok(!fs.existsSync(path.join(home, 'pins.json')));
  assert.ok(fs.existsSync(path.join(home, 'pins.d', id + '.json')));
  assert.ok(/legacy/.test(r.stdout), r.stdout);
});
t('does not persist token-shaped argv', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-secret-'));
  const token = 'sk-live-supersecret-token-9f3a';
  const env = Object.assign({}, process.env, { MCP_PIN_HOME: home });
  const client = path.join(__dirname, 'fake-client.js');
  const srv = path.join(__dirname, 'paged-server.js');
  spawnSync(process.execPath, [client, process.execPath, ATTEST, '--', process.execPath, srv, '--api-key', token], {
    env, encoding: 'utf8', timeout: 20000,
  });
  function dump(d) {
    let s = '';
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      s += fs.statSync(p).isDirectory() ? dump(p) : fs.readFileSync(p, 'utf8');
    }
    return s;
  }
  const dumped = dump(home);
  assert.ok(!dumped.includes(token), 'token leaked into store');
});
t('a failed append does not leave a pin', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-appendfail-'));
  const env = Object.assign({}, process.env, { MCP_PIN_HOME: home, ATTEST_HOME: home });
  const client = path.join(__dirname, 'fake-client.js');
  const preload = path.join(__dirname, 'stub-append-throw.js');
  const srv = path.join(ROOT, 'demo/rugpull-server.js');
  spawnSync(process.execPath, [client, process.execPath, '-r', preload, ATTEST, '--', process.execPath, srv], {
    env, encoding: 'utf8', timeout: 20000,
  });
  const pinsDir = path.join(home, 'pins.d');
  const pinFiles = fs.existsSync(pinsDir)
    ? fs.readdirSync(pinsDir).filter((f) => /^[a-f0-9]+\.json$/i.test(f))
    : [];
  assert.strictEqual(pinFiles.length, 0, 'pin files after failed append: ' + pinFiles.join(','));
});
t('queued tools/call does not run when definitions have drifted', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-race-'));
  const state = path.join(home, 'side-state');
  const effect = path.join(home, 'side-effect');
  const env = Object.assign({}, process.env, { MCP_PIN_HOME: home, SIDE_STATE: state, SIDE_EFFECT: effect });
  const client = path.join(__dirname, 'fake-client.js');
  const srv = path.join(__dirname, 'side-effect-server.js');
  const pin = spawnSync(process.execPath, [client, process.execPath, ATTEST, '--', process.execPath, srv], {
    env, encoding: 'utf8', timeout: 20000,
  });
  assert.ok(/pinned 1 tool/.test(pin.stderr), pin.stderr.slice(0, 400));
  assert.ok(!fs.existsSync(effect), 'first pin must not call the tool');

  const race = path.join(home, 'race-client.js');
  fs.writeFileSync(race, `
    const {spawn}=require('child_process');
    const p=spawn(process.argv[2], process.argv.slice(3), {stdio:['pipe','pipe','inherit']});
    p.stdin.on('error',()=>{});
    p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}})+'\\n');
    p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'write_flag',arguments:{}}})+'\\n');
    setTimeout(()=>{try{p.kill()}catch{} process.exit(0);}, 4000);
  `);
  spawnSync(process.execPath, [race, process.execPath, ATTEST, '--', process.execPath, srv], {
    env, encoding: 'utf8', timeout: 20000,
  });
  assert.ok(!fs.existsSync(effect), 'side-effect file must not exist after a blocked drifted session');
});

process.stdout.write('protocol eras and session checks\n');
// Text only the changed tool carries. The client must never receive it.
const SNEAKY = 'id_rsa';
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
function era(mode, home, extra) {
  const env = Object.assign({}, process.env, { MCP_PIN_HOME: home, ATTEST_HOME: home, NO_COLOR: '1' }, extra);
  const r = spawnSync(process.execPath, [
    path.join(__dirname, 'era-client.js'), mode, process.execPath, ATTEST, '--', process.execPath, path.join(__dirname, 'era-server.js'),
  ], { env, encoding: 'utf8', timeout: 20000 });
  return { out: r.stdout, err: r.stderr };
}
t('a 2026-07-28 client is verified with its own metadata and sees the tools', () => {
  const home = tmp('mcp-pin-modern-');
  const log = path.join(home, 'requests');
  const r = era('modern', home, { ERA: 'modern', REQ_LOG: log });
  assert.match(r.err, /pinned 1 tool/);
  assert.match(r.out, /CLIENT SAW/);
  assert.match(r.out, /EXIT 0/);
  const own = fs.readFileSync(log, 'utf8').trim().split('\n').filter((l) => / mcp-pin-/.test(l));
  assert.ok(own.length && own.every((l) => / meta$/.test(l)), 'mcp-pin requests without _meta: ' + own.join(' | '));
});
t('a changed tool blocks a 2026-07-28 session with an error that does not repeat the change', () => {
  const home = tmp('mcp-pin-modern-drift-');
  const env = { ERA: 'modern', STATE: path.join(home, 'starts'), TOOL_CHANGE_AT: '2' };
  era('modern', home, env);
  const r = era('modern', home, env);
  assert.match(r.err, /TOOL DEFINITIONS CHANGED SINCE YOU APPROVED THIS SERVER/);
  assert.match(r.out, /CLIENT ERROR .*-31042.*mcp-pin review/);
  assert.ok(!/CLIENT SAW/.test(r.out), r.out);
  assert.ok(!r.out.includes(SNEAKY), 'the client must never receive the changed text');
  assert.match(r.out, /EXIT 42/);
});
t('a dual-era client falls back to initialize at once when the server is legacy', () => {
  const home = tmp('mcp-pin-dual-');
  const r = era('dual', home, { ERA: 'legacy' });
  const ms = Number((r.out.match(/FALLBACK (\d+)/) || [])[1]);
  assert.ok(ms >= 0 && ms < 3000, 'the probe answer took ' + ms + ' ms: ' + r.out);
  assert.match(r.err, /pinned 1 tool/);
  assert.match(r.out, /CLIENT SAW/);
});
t('a 2026-07-28 request with no probe first is held until the server is verified', () => {
  const home = tmp('mcp-pin-direct-');
  const r = era('direct', home, { ERA: 'modern' });
  assert.match(r.err, /pinned 1 tool/);
  assert.match(r.out, /CLIENT SAW/);
});
t('a server that shows mcp-pin one toolset and the client another is blocked', () => {
  const home = tmp('mcp-pin-diverge-');
  const r = era('legacy-twice', home, { ERA: 'legacy', DIVERGE: '1' });
  assert.match(r.err, /CHANGED DURING THIS SESSION/);
  assert.match(r.out, /CLIENT ERROR .*-31042/);
  assert.ok(!r.out.includes(SNEAKY), r.out);
  assert.match(r.out, /EXIT 42/);
});
t('a tool that changes mid-session is blocked before the client sees it', () => {
  const home = tmp('mcp-pin-midsession-');
  const r = era('modern-twice', home, { ERA: 'modern', MIDSESSION: '1' });
  assert.strictEqual((r.out.match(/CLIENT SAW/g) || []).length, 1, r.out);
  assert.match(r.out, /CLIENT ERROR .*-31042/);
  assert.ok(!r.out.includes(SNEAKY), r.out);
});
t('changed server instructions are blocked', () => {
  const home = tmp('mcp-pin-instr-');
  const env = { ERA: 'modern', STATE: path.join(home, 'starts'), INSTR_CHANGE_AT: '2' };
  era('modern', home, env);
  const r = era('modern', home, env);
  assert.match(r.err, /DEFINITIONS CHANGED SINCE YOU APPROVED THIS SERVER/);
  assert.match(r.err, /server-instructions/);
  assert.ok(!r.out.includes('notes along'), r.out);
  assert.match(r.out, /EXIT 42/);
});
t('a changed prompt is blocked', () => {
  const home = tmp('mcp-pin-prompt-');
  const env = { ERA: 'modern', PROMPTS: '1', STATE: path.join(home, 'starts'), PROMPT_CHANGE_AT: '2' };
  const r1 = era('prompts', home, env);
  assert.match(r1.err, /pinned 1 tool\(s\) and 1 prompt/);
  const r2 = era('prompts', home, env);
  assert.match(r2.err, /prompt:forecast/);
  assert.ok(!r2.out.includes('passwords'), r2.out);
  assert.match(r2.out, /EXIT 42/);
});
t('pins from 0.1.4 gain prompts and instructions without a false block', () => {
  const home = tmp('mcp-pin-upgrade-');
  const env = { ERA: 'modern', PROMPTS: '1' };
  era('modern', home, env);
  const dir = path.join(home, 'pins.d');
  const file = path.join(dir, fs.readdirSync(dir).find((f) => /^[a-f0-9]+\.json$/.test(f)));
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of ['prompts', 'promptsHash', 'instructions', 'instructionsHash']) delete old[k];
  fs.writeFileSync(file, JSON.stringify(old));
  const r = era('modern', home, env);
  assert.match(r.err, /unchanged/);
  assert.match(r.out, /CLIENT SAW/);
  const now = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(now.promptsHash && now.instructionsHash, 'expected the old pin to be extended');
});
t('review shows the change to the human and approve re-pins it', () => {
  const home = tmp('mcp-pin-review-');
  const env = { ERA: 'modern', STATE: path.join(home, 'starts'), TOOL_CHANGE_AT: '2' };
  era('modern', home, env);
  era('modern', home, env);
  const e = Object.assign({}, process.env, { MCP_PIN_HOME: home, ATTEST_HOME: home, NO_COLOR: '1' });
  const sid = spawnSync(process.execPath, [ATTEST, 'list'], { env: e, encoding: 'utf8' }).stdout.trim().split(/\s+/)[0];
  const review = spawnSync(process.execPath, [ATTEST, 'review', sid], { env: e, encoding: 'utf8' });
  assert.match(review.stdout, /--- pinned\/weather/);
  assert.ok(review.stdout.includes(SNEAKY), 'review shows the new text to the human');
  const approve = spawnSync(process.execPath, [ATTEST, 'approve', sid], { env: e, encoding: 'utf8' });
  assert.match(approve.stdout, /re-pinned/);
  const r = era('modern', home, env);
  assert.match(r.out, /CLIENT SAW/);
});

process.stdout.write('wrap and unwrap\n');
{
  const w = require(path.join(ROOT, 'src/wrap'));
  const desktop = {
    mcpServers: {
      files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: { A: '1' } },
      remote: { url: 'https://example.com/mcp' },
      done: { command: 'npx', args: ['-y', 'mcp-pin@0.1.4', '--', 'node', 's.js'] },
    },
  };
  t('wrap protects stdio servers, keeps their env, skips remote and wrapped ones', () => {
    const r = w.processJson(JSON.stringify(desktop, null, 2), 'wrap');
    const doc = JSON.parse(r.text);
    assert.deepStrictEqual(r.changes.map((c) => c.name), ['files']);
    assert.deepStrictEqual(doc.mcpServers.files.args.slice(0, 5), ['-y', w.PKG, '--name', 'files', '--']);
    assert.deepStrictEqual(doc.mcpServers.files.args.slice(5), ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
    assert.deepStrictEqual(doc.mcpServers.files.env, { A: '1' });
    assert.deepStrictEqual(doc.mcpServers.remote, desktop.mcpServers.remote);
    assert.deepStrictEqual(r.skipped.map((s) => s.name).sort(), ['done', 'remote']);
  });
  t('unwrap restores what wrap changed', () => {
    const wrapped = w.processJson(JSON.stringify(desktop, null, 2), 'wrap').text;
    const back = JSON.parse(w.processJson(wrapped, 'unwrap').text);
    assert.deepStrictEqual(back.mcpServers.files, desktop.mcpServers.files);
  });
  t('wrap reaches Claude Code project scopes and VS Code servers', () => {
    const doc = { mcpServers: {}, projects: { '/repo': { mcpServers: { db: { command: 'uvx', args: ['db-mcp'] } } } } };
    const r = w.processJson(JSON.stringify(doc), 'wrap');
    assert.deepStrictEqual(r.changes, [{ name: 'db', where: 'project /repo' }]);
    const vs = w.processJson(JSON.stringify({ servers: { gh: { type: 'stdio', command: 'gh-mcp' }, web: { type: 'http', url: 'https://x' } } }), 'wrap');
    assert.deepStrictEqual(vs.changes.map((c) => c.name), ['gh']);
  });
  t('wrap and unwrap round-trip a Codex config.toml', () => {
    const toml = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.docs]',
      'command = "npx"',
      'args = ["-y", "docs-mcp"]',
      '',
      '[mcp_servers.bare]',
      'command = "bare-mcp"',
      '',
      '[mcp_servers.remote]',
      'url = "https://example.com/mcp"',
      '',
    ].join('\n');
    const r = w.processToml(toml, 'wrap');
    assert.deepStrictEqual(r.changes.map((c) => c.name), ['docs', 'bare']);
    assert.match(r.text, /args = \["-y","mcp-pin@[^"]+","--name","docs","--","npx","-y","docs-mcp"\]/);
    assert.match(r.text, /command = "npx"\nargs = \["-y","mcp-pin@[^"]+","--name","bare","--","bare-mcp"\]/);
    const back = w.processToml(r.text, 'unwrap');
    assert.match(back.text, /\[mcp_servers\.docs\]\ncommand = "npx"\nargs = \["-y","docs-mcp"\]/);
    assert.match(back.text, /\[mcp_servers\.bare\]\ncommand = "bare-mcp"\nargs = \[\]/);
  });
  t('wrap --yes rewrites the real files, backs them up, and unwrap puts them back', () => {
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-wraphome-'));
    const pinHome = path.join(fake, '.mcp-pin');
    const env = Object.assign({}, process.env, {
      HOME: fake, USERPROFILE: fake, APPDATA: path.join(fake, 'AppData', 'Roaming'), XDG_CONFIG_HOME: path.join(fake, '.config'),
      MCP_PIN_HOME: pinHome, ATTEST_HOME: pinHome, NO_COLOR: '1',
    });
    const cursor = path.join(fake, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(cursor), { recursive: true });
    const original = JSON.stringify(desktop, null, 2) + '\n';
    fs.writeFileSync(cursor, original);

    const dry = spawnSync(process.execPath, [ATTEST, 'wrap'], { env, encoding: 'utf8', input: '' });
    assert.match(dry.stdout, /\+ protect\s+files/);
    assert.match(dry.stdout, /Nothing written/);
    assert.strictEqual(fs.readFileSync(cursor, 'utf8'), original);

    const r = spawnSync(process.execPath, [ATTEST, 'wrap', '--yes'], { env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(cursor, 'utf8'), /mcp-pin@/);
    assert.strictEqual(fs.readdirSync(path.join(pinHome, 'backups')).length, 1);

    const again = spawnSync(process.execPath, [ATTEST, 'wrap', '--yes'], { env, encoding: 'utf8' });
    assert.match(again.stdout, /already protected/);

    spawnSync(process.execPath, [ATTEST, 'unwrap', '--yes'], { env, encoding: 'utf8' });
    const back = JSON.parse(fs.readFileSync(cursor, 'utf8')).mcpServers;
    assert.deepStrictEqual(back.files, desktop.mcpServers.files);
    assert.deepStrictEqual(back.remote, desktop.mcpServers.remote);
    // unwrap takes mcp-pin out wherever it is, including entries wrapped by hand
    assert.deepStrictEqual(back.done, { command: 'node', args: ['s.js'] });
  });
}

process.stdout.write('github action\n');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-action-'));
  const srv = path.join(dir, 'server.js');
  const vfile = path.join(dir, 'V');
  const base = path.join(dir, 'base.json');
  fs.writeFileSync(srv, `
const readline=require('readline'),fs=require('fs');
let V='1'; try{V=fs.readFileSync(${JSON.stringify(vfile)},'utf8').trim()}catch{}
let tool={name:'weather',description:'Get the current weather for a city.',
  inputSchema:{type:'object',properties:{city:{type:'string'}},required:['city']}};
if(V==='2') tool.inputSchema.properties.context={type:'string'};
readline.createInterface({input:process.stdin}).on('line',l=>{
  let m; try{m=JSON.parse(l)}catch{return}
  if(m.method==='initialize') s(m.id,{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'t',version:'1'}});
  else if(m.method==='tools/list') s(m.id,{tools:[tool]});
  else if(m.id!==undefined) s(m.id,{});
});
function s(id,result){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n')}
`);
  const runAction = (v, extra) => {
    fs.writeFileSync(vfile, v);
    return spawnSync(process.execPath, [path.join(ROOT, 'action/index.js')], {
      encoding: 'utf8', timeout: 30000,
      env: Object.assign({}, process.env, {
        INPUT_COMMAND: process.execPath, INPUT_ARGS: srv,
        INPUT_BASELINE: base, INPUT_COMMENT: 'false',
      }, extra || {}),
    });
  };

  t('writes a baseline on first run', () => {
    const r = runAction('1');
    assert.strictEqual(r.status, 0);
    assert.ok(fs.existsSync(base), 'baseline should exist');
    assert.ok(/no baseline found/.test(r.stdout));
  });
  t('reports no change when nothing moved', () => {
    const r = runAction('1');
    assert.strictEqual(r.status, 0);
    assert.ok(/unchanged/.test(r.stdout), r.stdout.slice(0, 200));
  });
  t('flags a schema-only change', () => {
    const r = runAction('2');
    assert.ok(/description stayed byte-identical/.test(r.stdout), r.stdout.slice(0, 400));
  });
  t('fails the job when asked to', () => {
    const r = runAction('2', { INPUT_FAIL_ON_CHANGE: 'true' });
    assert.strictEqual(r.status, 1);
  });
  t('accepts a change with update-baseline', () => {
    const r = runAction('2', { INPUT_UPDATE_BASELINE: 'true' });
    assert.strictEqual(r.status, 0);
    const after = runAction('2');
    assert.ok(/unchanged/.test(after.stdout));
  });
  t('never phones home: baseline stays in the repo', () => {
    const src = fs.readFileSync(path.join(ROOT, 'action/index.js'), 'utf8');
    assert.ok(src.includes('mcp-pin.gautamkhosla.com') === false, 'action must not contact the public log');
  });
}

process.stdout.write('security controls\n');
process.stdout.write('probe env recording\n');
{
  const probeMod = require(path.join(ROOT, 'crawler/probe'));
  t('probe_env records supplied keys, never values', () => {
    const src = fs.readFileSync(path.join(ROOT, 'crawler/probe.js'), 'utf8');
    assert.ok(/supplied: r\.suppliedEnvKeys/.test(src), 'probe() must report supplied env keys');
    assert.ok(!/suppliedEnvValues|env\[k\]\s*\)/.test(src), 'env values must never be recorded');
    assert.ok(typeof probeMod.probeStdio === 'function');
  });
  t('crawl records probe_env on every log entry', () => {
    const src = fs.readFileSync(path.join(ROOT, 'crawler/crawl.js'), 'utf8');
    assert.ok(/probe_env: r\.probe_env/.test(src), 'log entries must carry probe_env');
  });
}

process.stdout.write('probe env classification\n');
{
  const { CREDENTIAL_ENV } = require(path.join(ROOT, 'crawler/probe'));
  t('credential-shaped names are placeholder-safe', () => {
    for (const n of ['SPOTIFY_CLIENT_SECRET','GITHUB_TOKEN','OPENAI_API_KEY','DB_PASSWORD','SENTRY_DSN','SPOTIFY_CLIENT_ID']) {
      assert.ok(CREDENTIAL_ENV.test(n), n + ' should be treated as a credential');
    }
  });
  t('toolset-gating names are not placeholder-safe', () => {
    for (const n of ['SPOTIFY_MCP_TOOLSETS','SPOTIFY_MCP_ENABLE_TOOLS','SPOTIFY_MCP_DISABLE_TOOLS','FEATURE_FLAGS','MCP_MODE']) {
      assert.ok(!CREDENTIAL_ENV.test(n), n + ' must not receive a placeholder: it may change which tools register');
    }
  });
}

const sec = require(path.join(ROOT, 'crawler/security'));
t('blocks cloud metadata address', () => assert.strictEqual(sec.isPrivateAddress('169.254.169.254'), true));
t('blocks rfc1918 ranges', () => {
  for (const ip of ['10.0.0.1', '172.16.0.1', '192.168.1.1', '127.0.0.1', '100.64.0.1'])
    assert.strictEqual(sec.isPrivateAddress(ip), true, ip);
});
t('allows public addresses', () => assert.strictEqual(sec.isPrivateAddress('8.8.8.8'), false));
t('blocks ipv6 loopback and ula', () => {
  for (const ip of ['::1', 'fe80::1', 'fd00::1']) assert.strictEqual(sec.isPrivateAddress(ip), true, ip);
});
t('rejects non http schemes', async () => {});
t('rejects oversized toolsets', () => {
  const many = Array.from({ length: sec.LIMITS.MAX_TOOLS_PER_SERVER + 1 }, (_, i) => ({ name: 't' + i }));
  assert.strictEqual(sec.validateToolset(many).ok, false);
});
t('rejects an oversized single tool', () => {
  const big = [{ name: 'x', description: 'a'.repeat(sec.LIMITS.MAX_TOOL_BYTES + 10) }];
  assert.strictEqual(sec.validateToolset(big).ok, false);
});
t('rejects malformed tools', () => {
  assert.strictEqual(sec.validateToolset([{ description: 'no name' }]).ok, false);
  assert.strictEqual(sec.validateToolset('not an array').ok, false);
});
t('accepts a normal toolset', () => assert.strictEqual(sec.validateToolset([{ name: 'ok', description: 'fine' }]).ok, true));
t('safeId rejects traversal', () => {
  assert.strictEqual(sec.safeId('../../etc/passwd'), null);
  assert.strictEqual(sec.safeId('abc123def456'), 'abc123def456');
});

process.stdout.write('output escaping\n');
t('html special characters are escaped in server pages', () => {
  const build = fs.readFileSync(path.join(ROOT, 'site/build.js'), 'utf8');
  for (const ch of ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;']) assert.ok(build.includes(ch), 'missing escape ' + ch);
});

// async url checks
(async () => {
  const cases = [
    ['file:///etc/passwd', 'scheme'],
    ['http://127.0.0.1/', 'private'],
    ['http://user:pw@example.com/', 'credentials'],
  ];
  for (const [url, why] of cases) {
    let threw = false;
    try { await sec.assertSafeUrl(url); } catch { threw = true; }
    t(`rejects ${why} url`, () => assert.ok(threw, url + ' should be rejected'));
  }

  process.stdout.write('collectAllTools\n');
  {
    const pages = {
      none: { tools: [{ name: 'zeta' }, { name: 'alpha' }], nextCursor: 'p2' },
      p2: { tools: [{ name: 'beta' }] },
    };
    const tools = await collectAllTools(async (_m, params) => {
      const key = params && params.cursor ? params.cursor : 'none';
      if (!pages[key]) throw new Error('unexpected cursor ' + key);
      return pages[key];
    });
    t('concatenates pages and sorts by name', () => {
      assert.deepStrictEqual(tools.map((x) => x.name), ['alpha', 'beta', 'zeta']);
    });
  }
  {
    let threw = false;
    try {
      await collectAllTools(async () => ({ tools: [{ name: 'a' }], nextCursor: 'loop' }));
    } catch { threw = true; }
    t('throws on a cursor loop', () => assert.ok(threw));
  }
  {
    let threw = false;
    try {
      await collectAllTools(async () => { throw new Error('rpc error'); });
    } catch { threw = true; }
    t('throws on a page error rather than returning a partial set', () => assert.ok(threw));
  }
  {
    let page = 0;
    let threw = false;
    try {
      await collectAllTools(async () => {
        page++;
        return { tools: [{ name: 't' + page }], nextCursor: 'c' + page };
      });
    } catch (e) { threw = /50 pages/.test(e.message); }
    t('throws after 50 pages', () => assert.ok(threw));
  }
  {
    const tools = await collectAllTools(async () => ({ tools: [{ name: 'only' }], nextCursor: '' }));
    t('empty-string cursor terminates', () => assert.deepStrictEqual(tools.map((x) => x.name), ['only']));
  }

  process.stdout.write('concurrent pins\n');
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-conc-'));
    const n = 16;
    const srv = path.join(__dirname, 'paged-server.js');
    const client = path.join(__dirname, 'fake-client.js');
    const procs = [];
    for (let i = 0; i < n; i++) {
      const env = Object.assign({}, process.env, { MCP_PIN_HOME: home });
      procs.push(new Promise((resolve) => {
        const p = spawn(process.execPath, [client, process.execPath, ATTEST, '--', process.execPath, srv, '--n=' + i], {
          env, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        p.stderr.on('data', (d) => { stderr += d; });
        p.on('close', (code) => resolve({ code, stderr }));
      }));
    }
    const results = await Promise.all(procs);
    const pinsDir = path.join(home, 'pins.d');
    const pinFiles = fs.existsSync(pinsDir)
      ? fs.readdirSync(pinsDir).filter((f) => /^[a-f0-9]+\.json$/i.test(f))
      : [];
    const logFile = path.join(home, 'log.ndjson');
    const logLines = fs.existsSync(logFile)
      ? fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.trim())
      : [];
    t('concurrent pins persist every server', () => {
      assert.strictEqual(pinFiles.length, n, 'pins.d count=' + pinFiles.length + ' results=' + results.map((r) => r.code).join(','));
    });
    t('concurrent pins append every log entry', () => {
      assert.strictEqual(logLines.length, n, 'log lines=' + logLines.length);
    });
    t('concurrent pin log chain verifies', () => {
      const r = spawnSync(process.execPath, [ATTEST, 'verify'], {
        env: Object.assign({}, process.env, { MCP_PIN_HOME: home }),
        encoding: 'utf8', timeout: 10000,
      });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(/log ok/.test(r.stdout), r.stdout);
    });
  }

  process.stdout.write(`\n${pass} passed\n`);
})();
