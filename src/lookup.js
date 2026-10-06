'use strict';
/*
 * mcp-pin lookup: mcp-pin as an MCP server, so an agent can ask before it
 * trusts a server ("has this server's tools changed?") and after a block
 * ("which of my servers is waiting for review?").
 *
 * Read-only. It never returns third-party text: no tool descriptions from the
 * public log, no changed definitions from a pending review. Those are what an
 * attacker controls, and this server's output goes straight to the model.
 * Names are reduced to a safe character set; everything else is dates,
 * counts, hashes and fixed label keys.
 *
 *   mcp-pin lookup                     stdio, for a local AI app
 *   mcp-pin lookup --http 8787         Streamable HTTP on 127.0.0.1, public tools only
 */
const fs = require('fs');
const http = require('http');
const readline = require('readline');

const VERSION = require('../package.json').version;
const API = process.env.MCP_PIN_API || 'https://mcp-pin.gautamkhosla.com/api/servers.json';
const SITE = 'https://mcp-pin.gautamkhosla.com';
const PV = 'io.modelcontextprotocol/protocolVersion';
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MODERN = ['2026-07-28'];
const CACHE_MS = 10 * 60 * 1000;

const INSTRUCTIONS =
  'mcp-pin pins the tool definitions of MCP servers and blocks a server when they change after approval. ' +
  'Use mcp_pin_server_status before installing or approving a public MCP server. ' +
  'Use mcp_pin_my_servers and mcp_pin_change_summary after mcp-pin blocks a server. ' +
  'These tools never return the changed text itself; the user reviews it in a terminal.';

// Names come from third parties. Keep them to the characters MCP recommends
// for tool names (plus @ and / for npm scopes), so a name cannot carry prose.
function safeName(s) {
  return String(s == null ? '' : s).replace(/[^A-Za-z0-9_.@/-]/g, '').slice(0, 96);
}

function day(iso) {
  return typeof iso === 'string' ? iso.slice(0, 10) : null;
}

/* ------------------------------------------------------------- tools */

const TOOLS = [
  {
    name: 'mcp_pin_server_status',
    title: 'Public MCP server status',
    description:
      'Look up a public MCP server in the signed public log kept by mcp-pin, to see whether its tool definitions have changed and when. ' +
      'Use it before installing or approving an MCP server, or when the user asks if a server changed. ' +
      'Input: query, an npm package name (for example @modelcontextprotocol/server-filesystem) or part of one. ' +
      'Returns up to 5 matching servers, exact name first: name, registry, tool count, first seen date, last change date with the earliest day it could have happened, last successful check, and a link to the full history. ' +
      'Only names, dates and counts are returned, never tool descriptions. ' +
      'An unchanged server is not proof of safety: a server can be hostile from its first version.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 120, description: 'npm package name or part of it, for example "server-filesystem".' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    local: false,
  },
  {
    name: 'mcp_pin_my_servers',
    title: 'Servers mcp-pin protects here',
    description:
      'List the MCP servers mcp-pin protects on this machine and whether any of them has a change waiting for review. ' +
      'Use it when the user asks which servers are pinned, or after mcp-pin blocked a server. ' +
      'No input. Returns, per server: id, label, tool and prompt counts, the date it was approved, and pending (true when a change is waiting). ' +
      'It never returns definitions or changed text. For a pending change, call mcp_pin_change_summary with its id, then ask the user to run "mcp-pin review <id>" in a terminal to read the diff.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    local: true,
  },
  {
    name: 'mcp_pin_change_summary',
    title: 'What kind of change is waiting',
    description:
      'Explain what kind of change mcp-pin blocked on one pinned server, without the changed text. ' +
      'Use it after mcp_pin_my_servers shows pending: true, to tell the user what they are about to review. ' +
      'Input: id, the 16-character server id from mcp_pin_my_servers. ' +
      'Returns one entry per changed tool, prompt or instruction block with label keys: new-tool, new-prompt, new-field, new-argument, instruction, secrets, link, hidden, hints, field-type, output-schema, field-removed, removed, wording. ' +
      'Approving is always the user\'s decision: never run "mcp-pin approve" for them.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: '^[a-f0-9]{16}$', description: 'Server id from mcp_pin_my_servers, for example "18d57558e558a5f4".' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    local: true,
  },
  {
    name: 'mcp_pin_how_to_protect',
    title: 'How to protect MCP servers',
    description:
      'Give the exact steps to put mcp-pin in front of MCP servers in one AI app, so the user can copy them. ' +
      'Use it when the user asks how to protect their MCP servers or set up mcp-pin. ' +
      'Input: app, one of every_app, claude_code, claude_desktop, cursor, vscode, codex, gemini_cli, one_server. ' +
      'Returns the commands or config text for that app and the version they pin. It changes nothing by itself.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', enum: ['every_app', 'claude_code', 'claude_desktop', 'cursor', 'vscode', 'codex', 'gemini_cli', 'one_server'], description: 'Which app to protect. every_app covers all of them at once.' },
      },
      required: ['app'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    local: false,
  },
];

/* ------------------------------------------------------- tool bodies */

let cache = null;

async function publicServers() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.list;
  let list;
  if (/^https?:\/\//.test(API)) {
    const r = await fetch(API, { headers: { 'user-agent': 'mcp-pin-lookup/' + VERSION } });
    if (!r.ok) throw new Error('public log answered ' + r.status);
    list = await r.json();
  } else {
    list = JSON.parse(fs.readFileSync(API, 'utf8'));
  }
  if (!Array.isArray(list)) throw new Error('unexpected public log format');
  cache = { at: Date.now(), list };
  return list;
}

async function serverStatus(args) {
  const q = String(args.query || '').trim().toLowerCase();
  if (q.length < 2) throw new Error('query needs at least 2 characters');
  const list = await publicServers();
  const hits = list
    .filter((s) => s && typeof s.name === 'string' && s.name.toLowerCase().includes(q))
    .sort((a, b) => (a.name.toLowerCase() === q ? -1 : 0) - (b.name.toLowerCase() === q ? -1 : 0) || a.name.length - b.name.length)
    .slice(0, 5)
    .map((s) => ({
      name: safeName(s.name),
      registry: safeName(s.source),
      tools: Number.isFinite(s.tool_count) ? s.tool_count : null,
      first_seen: day(s.first_seen_at),
      last_change: day(s.last_change_at),
      change_window_from: day(s.last_change_after),
      last_checked_ok: day(s.last_ok_at),
      history: /^[a-f0-9]{8,64}$/.test(String(s.id)) ? `${SITE}/servers/${s.id}` : null,
    }));
  const text = hits.length
    ? hits.map((h) => `${h.name} (${h.registry}): ${h.tools} tools, first seen ${h.first_seen}, ` +
        (h.last_change ? `last changed ${h.change_window_from && h.change_window_from !== h.last_change ? 'between ' + h.change_window_from + ' and ' : 'on '}${h.last_change}` : 'no change recorded') +
        `, last checked ${h.last_checked_ok || 'never'}. History: ${h.history}`).join('\n')
    : `No public server matching "${safeName(q)}" in the mcp-pin log. The log covers stdio servers it can start without credentials; absence says nothing about safety.`;
  return { text, structured: { query: safeName(q), matches: hits } };
}

function myServers() {
  const store = require('./store');
  const pins = store.readPins();
  const servers = Object.keys(pins).map((k) => {
    const p = pins[k];
    return {
      id: safeName(k),
      label: safeName(p.label),
      tools: Array.isArray(p.tools) ? p.tools.length : 0,
      prompts: Array.isArray(p.prompts) ? p.prompts.length : null,
      approved: day(p.pinned_at),
      pending: !!p.pending,
    };
  });
  const waiting = servers.filter((s) => s.pending);
  const text = servers.length
    ? `mcp-pin protects ${servers.length} server(s) here. ` +
      (waiting.length ? `${waiting.length} waiting for review: ${waiting.map((s) => s.label + ' (' + s.id + ')').join(', ')}.` : 'None is waiting for review.')
    : 'mcp-pin has not pinned any server on this machine yet.';
  return { text, structured: { servers } };
}

function changeSummary(args) {
  const id = String(args.id || '');
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('id must be the 16-character server id from mcp_pin_my_servers');
  const store = require('./store');
  const p = store.getPin(id);
  if (!p) throw new Error('no pinned server with that id');
  if (!p.pending) return { text: `${safeName(p.label)} has no change waiting for review.`, structured: { id, pending: false, changes: [] } };
  const { diffDefinitions } = require('./definitions');
  const { summarize } = require('./classify');
  const changes = summarize(diffDefinitions(p, p.pending)).map((s) => ({
    name: safeName(s.name.replace(/^prompt /, '')) || 'server instructions',
    kind: s.name.startsWith('prompt ') ? 'prompt' : s.name === 'server instructions' ? 'instructions' : 'tool',
    level: s.level,
    labels: s.labels.map((l) => l.key),
  }));
  const text = `${safeName(p.label)} has a change waiting since ${day(p.pending.observed_at)}: ` +
    changes.map((c) => `${c.kind} ${c.name} [${c.labels.join(', ')}]`).join('; ') +
    `. Ask the user to read it with "mcp-pin review ${id}" in a terminal and decide; only they can approve it.`;
  return { text, structured: { id, pending: true, observed: day(p.pending.observed_at), changes } };
}

function howToProtect(args) {
  const pkg = 'mcp-pin@' + VERSION;
  const s = '<your server command>';
  const steps = {
    every_app: `Run once in a terminal:\n  npx -y ${pkg} wrap\nIt shows the plan, backs up each config file and protects every local MCP server in Claude Desktop, Claude Code, Cursor, VS Code, Gemini CLI, Devin Desktop, Windsurf, Cline and Codex. Undo with: npx -y ${pkg} unwrap`,
    claude_code: `claude mcp add <name> -- npx -y ${pkg} --name <name> -- ${s}`,
    claude_desktop: `In claude_desktop_config.json, per server:\n  "command": "npx", "args": ["-y", "${pkg}", "--name", "<name>", "--", ${JSON.stringify(s)}]`,
    cursor: `In ~/.cursor/mcp.json, per server:\n  "command": "npx", "args": ["-y", "${pkg}", "--name", "<name>", "--", ${JSON.stringify(s)}]`,
    vscode: `In your mcp.json, per stdio server:\n  "type": "stdio", "command": "npx", "args": ["-y", "${pkg}", "--name", "<name>", "--", ${JSON.stringify(s)}]`,
    codex: `In ~/.codex/config.toml, per server:\n  command = "npx"\n  args = ["-y", "${pkg}", "--name", "<name>", "--", ${JSON.stringify(s)}]`,
    gemini_cli: `In ~/.gemini/settings.json under mcpServers, per server:\n  "command": "npx", "args": ["-y", "${pkg}", "--name", "<name>", "--", ${JSON.stringify(s)}]`,
    one_server: `npx -y ${pkg} -- ${s}`,
  };
  const app = String(args.app || '');
  if (!steps[app]) throw new Error('app must be one of ' + Object.keys(steps).join(', '));
  return { text: steps[app] + `\nThe first connect pins the server; any later change is blocked until the user approves it with mcp-pin approve.`, structured: { app, version: VERSION } };
}

const HANDLERS = {
  mcp_pin_server_status: serverStatus,
  mcp_pin_my_servers: myServers,
  mcp_pin_change_summary: changeSummary,
  mcp_pin_how_to_protect: howToProtect,
};

/* ---------------------------------------------------------- protocol */

function toolList(publicOnly) {
  return TOOLS.filter((t) => !(publicOnly && t.local)).map(({ local, ...t }) => t);
}

async function handle(msg, opts) {
  const modern = !!(msg.params && msg.params._meta && typeof msg.params._meta[PV] === 'string');
  const meta = { 'io.modelcontextprotocol/serverInfo': { name: 'mcp-pin-lookup', version: VERSION } };
  const done = (result) => Object.assign(modern ? { resultType: 'complete', _meta: meta } : {}, result);
  const caps = { tools: {} };
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params && msg.params.protocolVersion;
      return { protocolVersion: LEGACY.includes(asked) ? asked : LEGACY[0], capabilities: caps, serverInfo: { name: 'mcp-pin-lookup', version: VERSION }, instructions: INSTRUCTIONS };
    }
    case 'server/discover':
      return done({ supportedVersions: MODERN.concat(LEGACY), capabilities: caps, instructions: INSTRUCTIONS, ttlMs: 3600000, cacheScope: 'public' });
    case 'ping':
      return {};
    case 'tools/list':
      return done(Object.assign({ tools: toolList(opts.publicOnly) }, modern ? { ttlMs: 3600000, cacheScope: 'public' } : {}));
    case 'tools/call': {
      const name = msg.params && msg.params.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool || (opts.publicOnly && tool.local)) {
        const e = new Error('Unknown tool: ' + safeName(name));
        e.code = -32602;
        throw e;
      }
      try {
        const r = await HANDLERS[name]((msg.params && msg.params.arguments) || {});
        return done({ content: [{ type: 'text', text: r.text }], structuredContent: r.structured, isError: false });
      } catch (err) {
        return done({ content: [{ type: 'text', text: 'mcp-pin: ' + err.message }], isError: true });
      }
    }
    default: {
      const e = new Error('Method not found');
      e.code = -32601;
      throw e;
    }
  }
}

async function respond(msg, opts) {
  if (!msg || typeof msg !== 'object' || msg.id === undefined || msg.id === null || typeof msg.method !== 'string') return null;
  try {
    return { jsonrpc: '2.0', id: msg.id, result: await handle(msg, opts) };
  } catch (e) {
    return { jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message } };
  }
}

function serveStdio() {
  const rl = readline.createInterface({ input: process.stdin });
  const inflight = new Set();
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const p = respond(msg, { publicOnly: false }).then((out) => {
      if (out) process.stdout.write(JSON.stringify(out) + '\n');
    });
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  });
  // stdin closing is the shutdown signal; answer what is in flight first.
  rl.on('close', () => { Promise.allSettled([...inflight]).then(() => process.exit(0)); });
}

// Streamable HTTP for hosting as a remote connector. Public tools only:
// a hosted server must never expose the pins of the machine it runs on.
function serveHttp(port, host) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(body); } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      }
      const out = await respond(msg, { publicOnly: true });
      if (!out) { res.writeHead(202); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  server.listen(port, host, () => process.stderr.write(`mcp-pin lookup on http://${host}:${port} (public tools only)\n`));
}

module.exports = { TOOLS, respond, serveStdio, serveHttp, safeName };
