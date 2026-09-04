#!/usr/bin/env node
'use strict';
// Test fixture: two-page tools/list when PAGED=1.
const readline = require('readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    send(m.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'paged', version: '1' } });
  } else if (m.method === 'tools/list') {
    if (process.env.PAGED === '1') {
      const cursor = m.params && m.params.cursor;
      if (!cursor) send(m.id, { tools: [{ name: 'alpha', description: 'page 1' }], nextCursor: 'p2' });
      else if (cursor === 'p2') send(m.id, { tools: [{ name: 'beta', description: 'page 2' }] });
      else error(m.id, 'unknown cursor');
    } else {
      send(m.id, { tools: [{ name: 'alpha', description: 'page 1' }, { name: 'beta', description: 'page 2' }] });
    }
  } else if (m.id !== undefined) {
    send(m.id, {});
  }
});
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function error(id, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message } }) + '\n');
}
