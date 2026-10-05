'use strict';
/*
 * mcp-pin wrap / unwrap. Put mcp-pin in front of every local (stdio) MCP
 * server configured in the AI apps on this machine, and take it out again.
 *
 * Every file is backed up before it is written and written atomically. An
 * entry that is already wrapped is left alone, so running wrap twice is safe.
 * Remote (URL) servers are skipped: the proxy speaks stdio only. The pin id is
 * computed from the original command, so wrapping keeps existing pins.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = require('../package.json').version;
const PKG = 'mcp-pin@' + VERSION;

function home() {
  return os.homedir();
}

function appConfigDir() {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(home(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(home(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(home(), '.config');
}

// Where each app keeps its MCP servers, from each app's own MCP docs
// (checked 5 Oct 2026). Anything else: --config <file>.
function knownClients() {
  const cfg = appConfigDir();
  const devin = process.platform === 'win32'
    ? path.join(cfg, 'devin', 'mcp_config.json')
    : path.join(home(), '.config', 'devin', 'mcp_config.json');
  return [
    { name: 'Claude Desktop', file: path.join(cfg, 'Claude', 'claude_desktop_config.json') },
    { name: 'Claude Code', file: path.join(home(), '.claude.json') },
    { name: 'Cursor', file: path.join(home(), '.cursor', 'mcp.json') },
    { name: 'VS Code', file: path.join(cfg, 'Code', 'User', 'mcp.json') },
    { name: 'Gemini CLI', file: path.join(home(), '.gemini', 'settings.json') },
    { name: 'Devin Desktop', file: devin },
    { name: 'Windsurf', file: path.join(home(), '.codeium', 'windsurf', 'mcp_config.json') },
    { name: 'Cline', file: path.join(home(), '.cline', 'data', 'settings', 'cline_mcp_settings.json') },
    { name: 'Codex', file: path.join(home(), '.codex', 'config.toml') },
  ];
}

/* ------------------------------------------------------------ one entry */

function isStdio(entry) {
  return !!entry && typeof entry === 'object' && typeof entry.command === 'string' && !entry.url &&
    (entry.type === undefined || entry.type === 'stdio');
}

function isWrapped(entry) {
  const a = Array.isArray(entry.args) ? entry.args : [];
  return entry.command === 'mcp-pin' || a.some((x) => typeof x === 'string' && /^mcp-pin(@|$)/.test(x));
}

function wrapEntry(name, entry) {
  const args = Array.isArray(entry.args) ? entry.args : [];
  return Object.assign({}, entry, { command: 'npx', args: ['-y', PKG, '--name', name, '--', entry.command].concat(args) });
}

function unwrapEntry(entry) {
  const a = Array.isArray(entry.args) ? entry.args : [];
  const i = a.indexOf('--');
  if (!isWrapped(entry) || i === -1 || i === a.length - 1) return null;
  return Object.assign({}, entry, { command: a[i + 1], args: a.slice(i + 2) });
}

// Decide what to do with one server entry. Returns null when it is not ours to touch.
function plan(mode, name, entry) {
  if (!isStdio(entry)) return { name, skip: 'remote server: the proxy speaks stdio only' };
  if (mode === 'wrap') {
    if (isWrapped(entry)) return { name, skip: 'already protected' };
    return { name, next: wrapEntry(name, entry) };
  }
  if (!isWrapped(entry)) return null;
  const next = unwrapEntry(entry);
  return next ? { name, next } : { name, skip: 'wrapped in a form mcp-pin does not recognise; left as it is' };
}

/* ---------------------------------------------------------------- JSON */

// The server maps inside one app's JSON config. Claude Code keeps a user
// scope map at the top and one per project under "projects".
function serverMaps(doc) {
  const maps = [];
  for (const key of ['mcpServers', 'servers']) {
    if (doc && doc[key] && typeof doc[key] === 'object' && !Array.isArray(doc[key])) maps.push({ where: key, map: doc[key] });
  }
  if (doc && doc.projects && typeof doc.projects === 'object') {
    for (const [dir, p] of Object.entries(doc.projects)) {
      if (p && p.mcpServers && typeof p.mcpServers === 'object') maps.push({ where: 'project ' + dir, map: p.mcpServers });
    }
  }
  return maps;
}

function processJson(text, mode) {
  let doc;
  try { doc = JSON.parse(text); } catch (e) {
    return { error: 'not valid JSON (' + e.message + '); edit it by hand' };
  }
  const changes = [];
  const skipped = [];
  for (const { where, map } of serverMaps(doc)) {
    for (const [name, entry] of Object.entries(map)) {
      const p = plan(mode, name, entry);
      if (!p) continue;
      if (p.skip) { skipped.push({ name, where, reason: p.skip }); continue; }
      map[name] = p.next;
      changes.push({ name, where });
    }
  }
  const indent = /^\s*\{\s*\n(\s+)/.exec(text);
  return { changes, skipped, text: JSON.stringify(doc, null, indent ? indent[1].length : 2) + '\n' };
}

/* ---------------------------------------------------------------- TOML */

// Codex keeps servers as [mcp_servers.<name>] tables in config.toml. Only the
// common shape is rewritten: command = "..." and a one-line args array of
// double-quoted strings. Anything else is reported for a manual edit.
function parseTomlString(v) {
  v = v.trim();
  if (v.startsWith('"')) { try { return JSON.parse(v); } catch { return undefined; } }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1);
  return undefined;
}

function parseTomlArray(v) {
  v = v.trim();
  if (!v.startsWith('[') || !v.endsWith(']')) return undefined;
  try {
    const arr = JSON.parse(v.replace(/,\s*\]$/, ']'));
    return Array.isArray(arr) && arr.every((x) => typeof x === 'string') ? arr : undefined;
  } catch { return undefined; }
}

function processToml(text, mode) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const tables = [];
  let cur = null;
  lines.forEach((line, i) => {
    const h = /^\s*\[\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]\s*(#.*)?$/.exec(line);
    if (h) { cur = { name: h[1] || h[2] || h[3], header: i }; tables.push(cur); return; }
    if (/^\s*\[/.test(line)) { cur = null; return; }
    if (!cur) return;
    const kv = /^(\s*)(command|args|url)\s*=\s*(.*?)\s*$/.exec(line);
    if (kv) cur[kv[2]] = { i, indent: kv[1], value: kv[3] };
  });

  const changes = [];
  const skipped = [];
  const inserts = [];
  for (const t of tables) {
    if (t.url) { skipped.push({ name: t.name, where: 'mcp_servers', reason: 'remote server: the proxy speaks stdio only' }); continue; }
    if (!t.command) continue;
    const command = parseTomlString(t.command.value);
    const args = t.args ? parseTomlArray(t.args.value) : [];
    if (command === undefined || args === undefined) {
      skipped.push({ name: t.name, where: 'mcp_servers', reason: 'command or args in a form mcp-pin does not rewrite; edit it by hand' });
      continue;
    }
    const p = plan(mode, t.name, { command, args });
    if (!p) continue;
    if (p.skip) { skipped.push({ name: t.name, where: 'mcp_servers', reason: p.skip }); continue; }
    lines[t.command.i] = `${t.command.indent}command = ${JSON.stringify(p.next.command)}`;
    const argsLine = `args = ${JSON.stringify(p.next.args)}`;
    if (t.args) lines[t.args.i] = t.args.indent + argsLine;
    else inserts.push({ after: t.command.i, line: t.command.indent + argsLine });
    changes.push({ name: t.name, where: 'mcp_servers' });
  }
  for (const ins of inserts.sort((a, b) => b.after - a.after)) lines.splice(ins.after + 1, 0, ins.line);
  return { changes, skipped, text: lines.join(eol) };
}

/* ------------------------------------------------------------ files */

function processFile(file, mode) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    return { error: 'cannot read (' + e.message + ')' };
  }
  return file.endsWith('.toml') ? processToml(text, mode) : processJson(text, mode);
}

function backupAndWrite(file, newText, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(backupDir, path.basename(file) + '.' + stamp + '.bak');
  fs.copyFileSync(file, backup);
  const tmp = file + '.mcp-pin.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, newText);
  fs.renameSync(tmp, file);
  return backup;
}

module.exports = {
  PKG, knownClients, isStdio, isWrapped, wrapEntry, unwrapEntry,
  processJson, processToml, processFile, backupAndWrite,
};
