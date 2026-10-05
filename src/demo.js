'use strict';
/*
 * mcp-pin demo. The whole failure, start to finish, with nothing to configure.
 *
 * A harmless bundled server (demo/drift-server.js) changes its one tool
 * between two sessions. The first session pins it; the second is blocked with
 * the diff. Everything runs in a temporary folder that is deleted afterwards:
 * your real pins are never read or written, no tool is ever called, and
 * nothing leaves this machine.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const ATTEST = path.join(ROOT, 'bin', 'attest.js');
const SERVER = path.join(ROOT, 'demo', 'drift-server.js');
const VERSION = require('../package.json').version;

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint(1), dim = paint(2), red = paint(31);
const say = (s) => process.stdout.write(s + '\n');

// One client session through the proxy: initialize, then tools/list. The
// proxy's own messages go straight to this terminal.
function session(env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [ATTEST, '--name', 'demo-weather', '--', process.execPath, SERVER],
      { env, stdio: ['pipe', 'pipe', 'inherit'] });
    let tools = null;
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { p.kill(); } catch {}
      resolve({ code, tools });
    };
    const timer = setTimeout(() => done(null), 20000);
    p.on('error', () => done(null));
    p.on('exit', (code) => done(code));
    p.stdin.on('error', () => {});
    const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
    readline.createInterface({ input: p.stdout }).on('line', (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.id === 1 && m.result) {
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      } else if (m.id === 2 && m.result) {
        tools = m.result.tools || [];
        done(0);
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-pin-demo', version: VERSION },
    } });
  });
}

async function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-demo-'));
  const home = path.join(tmp, 'home');
  const env = Object.assign({}, process.env, {
    MCP_PIN_HOME: home, ATTEST_HOME: home, DRIFT_STATE: path.join(tmp, 'connects'),
  });
  try {
    say('');
    say(bold('mcp-pin demo'));
    say(dim('A harmless test server changes its one tool between two sessions. Pins go to a'));
    say(dim('temporary folder that is deleted afterwards. No tool is called. Nothing leaves this machine.'));
    say('');
    say(bold('1/2  First session. You approve a weather tool.'));
    const first = await session(env);
    if (first.code !== 0 || !first.tools || !first.tools.length) {
      say(red('The first session did not finish, so nothing was pinned. Please open an issue.'));
      return 1;
    }
    say(`     the client sees: ${first.tools[0].name}, "${first.tools[0].description}"`);
    say('');
    say(bold('2/2  Next session. Same server, same command, nothing reinstalled.'));
    const second = await session(env);
    if (second.code !== 42) {
      say(red('mcp-pin should have blocked the second session and did not. Please open an issue.'));
      return 1;
    }
    say(dim('(The approve command above points at the demo\'s temporary pins, which are already deleted.)'));
    say('');
    say('Without mcp-pin, your client would load the new description and the new field');
    say('without asking you again, and the model reads descriptions as instructions.');
    say('');
    say('Put it in front of a real server:');
    say(bold(`  npx --yes mcp-pin@${VERSION} -- <your mcp server command>`));
    say('');
    return 0;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { run };
