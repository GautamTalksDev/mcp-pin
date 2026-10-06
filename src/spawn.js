'use strict';
/*
 * Start a server command the way MCP clients do. On Windows, Node cannot
 * start npx, uvx or any other .cmd or .bat shim without a shell, so such a
 * command is found on PATH and run through cmd.exe with every argument
 * escaped. This is the approach of cross-spawn (MIT), which the official
 * MCP TypeScript SDK uses to start stdio servers. Elsewhere it is a plain
 * spawn.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const META = /([()\][%!^"`<>&|;, *?])/g;

function getEnv(env, name) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

// The file Windows would run for this command: the current folder first,
// then PATH, trying each PATHEXT extension when the name has none.
function findWindows(command, env, cwd, exists) {
  const exts = (getEnv(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
  const own = path.win32.extname(command).toLowerCase();
  const names = own && exts.includes(own) ? [command] : exts.map((e) => command + e);
  const dirs = /[\\/]/.test(command) ? [cwd] : [cwd].concat((getEnv(env, 'PATH') || '').split(';').filter(Boolean));
  for (const d of dirs) {
    for (const n of names) {
      const f = path.win32.resolve(d, n);
      if (exists(f)) return f;
    }
  }
  return null;
}

function escapeCommand(s) {
  return s.replace(META, '^$1');
}

// Quote for the program's own argument parser, then escape for cmd.exe.
// npm's node_modules\.bin shims pass arguments through cmd a second time.
function escapeArgument(arg, twice) {
  let a = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  a = ('"' + a + '"').replace(META, '^$1');
  return twice ? a.replace(META, '^$1') : a;
}

function plan(command, args, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'win32') return { command, args, verbatim: false };
  const env = opts.env || process.env;
  const file = findWindows(command, env, opts.cwd || process.cwd(), opts.exists || fs.existsSync);
  if (!file || /\.(com|exe)$/i.test(file)) return { command, args, verbatim: false };
  const shim = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file);
  const line = [escapeCommand(file)].concat(args.map((a) => escapeArgument(a, shim))).join(' ');
  return { command: getEnv(env, 'COMSPEC') || 'cmd.exe', args: ['/d', '/s', '/c', '"' + line + '"'], verbatim: true };
}

function spawnServer(command, args, options = {}) {
  const p = plan(command, args, { env: options.env, cwd: options.cwd });
  return spawn(p.command, p.args, p.verbatim ? Object.assign({}, options, { windowsVerbatimArguments: true }) : options);
}

module.exports = { spawnServer, plan, escapeArgument };
