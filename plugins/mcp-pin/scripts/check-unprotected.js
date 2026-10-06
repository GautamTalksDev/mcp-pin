#!/usr/bin/env node
'use strict';
/*
 * SessionStart: one line for Claude listing the local MCP servers in this
 * setup that run without mcp-pin. Reads Claude Code's config files only.
 * Changes nothing, makes no network call, and prints nothing when every
 * local server is already protected.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const unprotected = new Set();
function scan(map) {
  for (const [name, e] of Object.entries(map || {})) {
    if (!e || typeof e.command !== 'string' || e.url || (e.type && e.type !== 'stdio')) continue;
    const args = Array.isArray(e.args) ? e.args : [];
    const wrapped = e.command === 'mcp-pin' || args.some((a) => typeof a === 'string' && /^mcp-pin(@|$)/.test(a));
    if (!wrapped) unprotected.add(name);
  }
}

const project = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const user = read(path.join(os.homedir(), '.claude.json'));
if (user) {
  scan(user.mcpServers);
  if (user.projects && user.projects[project]) scan(user.projects[project].mcpServers);
}
const shared = read(path.join(project, '.mcp.json'));
if (shared) scan(shared.mcpServers);
unprotected.delete('mcp-pin');

if (unprotected.size) {
  // Server names are the user's own config keys; keep them to a safe set.
  const names = [...unprotected].map((n) => String(n).replace(/[^A-Za-z0-9_.@/-]/g, '')).filter(Boolean).slice(0, 8);
  process.stdout.write(
    `mcp-pin: ${unprotected.size} local MCP server(s) here run without mcp-pin (${names.join(', ')}). ` +
      'Their tool definitions can change after approval without anyone noticing. ' +
      'If the user wants that covered, they can run: npx -y mcp-pin@0.2.2 wrap\n'
  );
}
