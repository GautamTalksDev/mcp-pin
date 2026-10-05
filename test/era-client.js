#!/usr/bin/env node
'use strict';
/*
 * Test fixture: an MCP client for either protocol era.
 *
 *   node era-client.js <mode> <command> [args...]
 *
 *   modern         server/discover, then tools/list (2026-07-28)
 *   modern-twice   server/discover, then tools/list twice
 *   direct         tools/list with _meta and no probe first
 *   prompts        server/discover, then prompts/list
 *   dual           server/discover; on any non-modern error fall back to initialize, then tools/list
 *   legacy-twice   initialize, then tools/list twice
 *
 * Prints one line per outcome: CLIENT SAW <json>, CLIENT ERROR <json>,
 * FALLBACK <ms>, and finally EXIT <code> for the proxy's exit code.
 */
const { spawn } = require('child_process');
const readline = require('readline');

const mode = process.argv[2];
const p = spawn(process.argv[3], process.argv.slice(4), { stdio: ['pipe', 'pipe', 'inherit'] });
const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'era-client', version: '1' },
};
const modernReq = (id, method) => ({ jsonrpc: '2.0', id, method, params: { _meta: meta } });
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
const started = Date.now();
let listings = 0;
let legacy = false;

function list(id) {
  send(legacy ? { jsonrpc: '2.0', id, method: 'tools/list' } : modernReq(id, 'tools/list'));
}

readline.createInterface({ input: p.stdout }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.error) console.log('CLIENT ERROR', JSON.stringify(m.error));

  if (m.id === 'probe') {
    if (m.result) {
      if (mode === 'prompts') send(modernReq('p1', 'prompts/list'));
      else list('l1');
    } else if (mode === 'dual') {
      console.log('FALLBACK', Date.now() - started);
      legacy = true;
      send({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'era-client', version: '1' } } });
    }
    return;
  }
  if (m.id === 'init' && m.result) {
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    list('l1');
    return;
  }
  if ((m.id === 'l1' || m.id === 'l2' || m.id === 'p1') && m.result) {
    console.log('CLIENT SAW', JSON.stringify(m.result));
    listings += 1;
    if ((mode === 'modern-twice' || mode === 'legacy-twice') && listings === 1) list('l2');
    else p.stdin.end();
  }
});

p.on('exit', (code) => {
  console.log('EXIT', code);
  process.exit(0);
});
p.stdin.on('error', () => {});

if (mode === 'legacy-twice') {
  legacy = true;
  send({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'era-client', version: '1' } } });
} else if (mode === 'direct') {
  list('l1');
} else {
  send(modernReq('probe', 'server/discover'));
}
setTimeout(() => { try { p.kill(); } catch {} }, 6000);
