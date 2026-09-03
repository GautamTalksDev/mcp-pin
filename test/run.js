#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { canonicalize, fingerprintToolset, sha256 } = require(path.join(ROOT, 'src/canonical'));
const { PublicLog } = require(path.join(ROOT, 'crawler/log'));
const { badgeFor } = require(path.join(ROOT, 'crawler/badge'));

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

process.stdout.write('badge\n');
t('never-changed server reads unchanged', () => {
  const svg = badgeFor({ set_hash: 'x', first_seen_at: new Date(Date.now() - 40 * 86400000).toISOString(), last_change_at: null });
  assert.ok(svg.includes('unchanged 40d'), svg.slice(0, 120));
});
t('recently changed server reads changed', () => {
  const svg = badgeFor({ set_hash: 'x', first_seen_at: '2026-01-01T00:00:00Z', last_change_at: new Date().toISOString() });
  assert.ok(svg.includes('changed today'));
});

process.stdout.write('proxy end to end\n');
t('pins on first connect, blocks on drift', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-home-'));
  const state = path.join(home, 'connects');
  const env = Object.assign({}, process.env, { ATTEST_HOME: home, RUGPULL_STATE: state });
  const client = path.join(__dirname, 'fake-client.js');
  const cmd = [path.join(ROOT, 'bin/attest.js'), '--', process.execPath, path.join(ROOT, 'demo/rugpull-server.js')];

  const r1 = spawnSync(process.execPath, [client, process.execPath, ...cmd], { env, encoding: 'utf8', timeout: 20000 });
  assert.ok(/pinned 1 tool/.test(r1.stderr), 'expected pin on first run');
  assert.ok(/CLIENT SAW/.test(r1.stdout), 'client should receive the benign toolset');

  const r2 = spawnSync(process.execPath, [client, process.execPath, ...cmd], { env, encoding: 'utf8', timeout: 20000 });
  assert.ok(/TOOL DEFINITIONS CHANGED/.test(r2.stderr), 'expected block on second run');
  assert.ok(!/CLIENT SAW/.test(r2.stdout), 'poisoned toolset must never reach the client');
});

process.stdout.write('security controls\n');
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
  process.stdout.write(`\n${pass} passed\n`);
})();
