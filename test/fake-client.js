// Minimal MCP client used only by the test suite.
const { spawn } = require('child_process');
const readline = require('readline');
const p = spawn(process.argv[2], process.argv.slice(3), { stdio: ['pipe', 'pipe', 'inherit'] });
readline.createInterface({ input: p.stdout }).on('line', (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.result && m.result.protocolVersion) p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  else if (m.id === 2 && m.result) { console.log('CLIENT SAW:', JSON.stringify(m).slice(0, 120)); p.kill(); process.exit(0); }
});
p.stdin.on('error', () => {});
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
// The concurrency test raises this: 16 wrappers on a slow Windows runner can
// take longer than 8 s, and a client that gives up kills its wrapper mid-pin.
const waitMs = Number(process.env.FAKE_CLIENT_TIMEOUT_MS) || 8000;
setTimeout(() => { console.error('CLIENT TIMEOUT'); p.kill(); process.exit(0); }, waitMs);
