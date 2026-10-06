'use strict';
/*
 * Admin policy that requires mcp-pin, generated from the servers an
 * organisation approved. Checked against each vendor's documentation on
 * 5 October 2026.
 *
 * Generated rather than written once, because Claude Code, GitHub Copilot
 * (and VS Code, which reads Copilot's managed settings) and Codex match a
 * stdio server's command exactly, every argument in order: "anything wrapped
 * in mcp-pin" cannot be one rule there, so each approved server is listed as
 * its exact wrapped command. Cursor's dashboard takes `*` wildcards, so one
 * pattern can require the wrapper for every server.
 *
 * With --lock, every wrapped command also carries --only-locked: a server the
 * organisation's lock does not list does not start.
 */
const { PKG, isStdio, wrapEntry, unwrapEntry } = require('./wrap');

const VAR = /\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*/;

// Plain values in env are visible to every user who can read the file.
function plainSecrets(env) {
  return Object.entries(env || {}).filter(([, v]) => typeof v === 'string' && v !== '' && !VAR.test(v)).map(([k]) => k);
}

// The approved servers, each in the wrapped form every policy lists.
function approvedServers(serverMap, opts = {}) {
  const extra = opts.lock ? ['--lock', opts.lock, '--only-locked'] : [];
  const out = [];
  for (const [name, entry] of Object.entries(serverMap || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (!isStdio(entry)) {
      if (typeof entry.url === 'string') out.push({ name, remote: true, entry, url: entry.url });
      continue;
    }
    const inner = unwrapEntry(entry) || entry;
    const wrapped = wrapEntry(name, inner, extra);
    delete wrapped.type;
    out.push({
      name, remote: false, inner, wrapped,
      command: [wrapped.command].concat(wrapped.args),
      original: [inner.command].concat(inner.args || []),
      plainEnv: plainSecrets(inner.env),
      usesVar: [inner.command].concat(inner.args || []).some((a) => VAR.test(String(a))),
    });
  }
  return out;
}

function commonNotes(list, product) {
  const notes = [];
  for (const s of list) {
    if (s.remote) notes.push(`${s.name}: a remote server, listed by URL. mcp-pin cannot sit in front of HTTP servers yet.`);
    else if (s.usesVar && product === 'copilot') notes.push(`${s.name}: its command uses a variable. Copilot blocks a server whose command still holds an unresolved variable; write the value out.`);
    else if (s.usesVar) notes.push(`${s.name}: its command uses a variable, so the allowlist entry is only as fixed as that variable.`);
  }
  return notes;
}

/* ------------------------------------------------------------ Claude Code */

function claudeCode(list) {
  const mcpServers = {};
  const allowed = [];
  const denied = [];
  const notes = commonNotes(list, 'claude-code');
  for (const s of list) {
    if (s.remote) { mcpServers[s.name] = s.entry; allowed.push({ serverUrl: s.url }); continue; }
    mcpServers[s.name] = Object.assign({ type: 'stdio' }, s.wrapped);
    allowed.push({ serverCommand: s.command });
    denied.push({ serverCommand: s.original });
    if (s.plainEnv.length) notes.push(`${s.name}: env ${s.plainEnv.join(', ')} has literal values, and managed-mcp.json is readable by every user. Write \${${s.plainEnv[0]}} so each user's own environment supplies it.`);
  }
  return {
    files: {
      'managed-mcp.json': JSON.stringify({ mcpServers }, null, 2) + '\n',
      'managed-settings.json': JSON.stringify({ allowManagedMcpServersOnly: true, allowedMcpServers: allowed, deniedMcpServers: denied }, null, 2) + '\n',
    },
    deploy: [
      'Pick one. managed-mcp.json is a fixed set: every user gets these servers, each through mcp-pin, and cannot add others.',
      'managed-settings.json is an approved catalog: users can add only these exact wrapped commands.',
      'macOS          /Library/Application Support/ClaudeCode/',
      'Linux and WSL  /etc/claude-code/',
      'Windows        C:\\Program Files\\ClaudeCode\\',
      'managed-settings.json can also go through server-managed settings or MDM; managed-mcp.json is a file on each machine only.',
    ],
    notes,
  };
}

/* ------------------------------------------------- GitHub Copilot, VS Code */

function copilot(list) {
  const allowed = [];
  const denied = [];
  for (const s of list) {
    if (s.remote) { allowed.push({ serverUrl: s.url }); continue; }
    allowed.push({ serverCommand: s.command });
    denied.push({ serverCommand: s.original });
  }
  return {
    files: { 'managed-settings.json': JSON.stringify({ allowedMcpServers: allowed, deniedMcpServers: denied }, null, 2) + '\n' },
    deploy: [
      'Covers Copilot CLI, Copilot in VS Code, JetBrains and the Copilot app. Not the Copilot cloud agent, which has only an on/off policy.',
      'macOS    /Library/Application Support/GitHubCopilot/managed-settings.json',
      'Windows  %ProgramFiles%\\GitHubCopilot\\managed-settings.json',
      'Linux    /etc/github-copilot/managed-settings.json   (Copilot CLI needs it owned by root and not writable by others)',
      'or server-managed: copilot/managed-settings.json in the enterprise .github-private repository.',
      'Allowlists from several sources intersect, so users cannot widen this one.',
      'VS Code reads the same file. Its allowlist is not yet enforced in Agent Host sessions (microsoft/vscode issue 328241).',
    ],
    notes: commonNotes(list, 'copilot'),
  };
}

/* ------------------------------------------------------------------ Codex */

const tomlKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
const tomlStr = (s) => JSON.stringify(String(s));

function codex(list) {
  const notes = commonNotes(list, 'codex');
  const req = ['# Only these MCP servers may run, each through mcp-pin. Generated by mcp-pin policy codex.'];
  const cfg = ['# The approved MCP servers, each through mcp-pin. Generated by mcp-pin policy codex.'];
  for (const s of list) {
    const key = tomlKey(s.name);
    if (s.remote) {
      req.push('', `[mcp_servers.${key}.identity]`, `url = ${tomlStr(s.url)}`);
      cfg.push('', `[mcp_servers.${key}]`, `url = ${tomlStr(s.url)}`);
      continue;
    }
    req.push('', `[mcp_servers.${key}.identity.command]`, `executable = ${tomlStr(s.command[0])}`, 'args = [');
    for (const a of s.command.slice(1)) req.push(`  { match = "exact", value = ${tomlStr(a)} },`);
    req.push(']');
    cfg.push('', `[mcp_servers.${key}]`, `command = ${tomlStr(s.command[0])}`, `args = [${s.command.slice(1).map(tomlStr).join(', ')}]`);
    // Values are never written to a shared file: each one is forwarded from
    // the user's own environment by name.
    const vars = Object.keys(s.inner.env || {});
    if (vars.length) cfg.push(`env_vars = [${vars.map(tomlStr).join(', ')}]`);
    if (s.plainEnv.length) notes.push(`${s.name}: env ${s.plainEnv.join(', ')} had literal values, which are not written out. They are forwarded by name, so set them in each user's environment.`);
  }
  return {
    files: { 'requirements.toml': req.join('\n') + '\n', 'config.toml': cfg.join('\n') + '\n' },
    deploy: [
      'requirements.toml decides which servers may run: a server runs only if its name and its exact wrapped command match.',
      'Linux and macOS  /etc/codex/requirements.toml',
      'Windows          %ProgramData%\\OpenAI\\Codex\\requirements.toml',
      'or the cloud requirements in the Admin Console, or MDM (domain com.openai.codex, key requirements_toml_base64).',
      'config.toml defines the same servers, so users have them without typing them: /etc/codex/config.toml, or MDM key config_toml_base64.',
    ],
    notes,
  };
}

/* ----------------------------------------------------------------- Cursor */

function cursor(list, opts = {}) {
  const lockPart = opts.lock ? ` --lock ${opts.lock} --only-locked` : '';
  const pattern = `*npx -y ${PKG}${lockPart} --name * -- *`;
  const lines = [
    'Cursor: Team Settings > MCP Configuration (Enterprise plan). There is no file format or API for this list; enter it in the dashboard.',
    '',
    'To require mcp-pin for every local server, one command entry:',
    '',
    `  ${pattern}`,
    '',
    opts.lock
      ? 'With the lock, a server the lock does not list does not start, so this one entry is also your approved catalog.'
      : 'Without a lock this requires the wrapper but admits any server inside it. Generate with --lock to allow only approved servers.',
    'Turn "User MCP extensions" off, or users can still run servers outside this list.',
    'A leading * matches npx at any path; how Cursor matches npx.cmd on Windows is not documented, so test one machine first.',
    '',
    'Or, to allow only these exact servers, one command entry each:',
    '',
  ];
  for (const s of list) {
    if (s.remote) lines.push(`  URL entry:      ${s.url}`);
    else lines.push(`  command entry:  *${s.command.join(' ')}`);
  }
  return {
    files: { 'cursor-dashboard.txt': lines.join('\n') + '\n' },
    deploy: ['Copy the entries from cursor-dashboard.txt into the dashboard.'],
    notes: commonNotes(list, 'cursor'),
  };
}

const PRODUCTS = { 'claude-code': claudeCode, copilot, codex, cursor };

function generate(product, serverMap, opts = {}) {
  const fn = PRODUCTS[product];
  if (!fn) throw new Error('unknown product ' + product);
  return fn(approvedServers(serverMap, opts), opts);
}

module.exports = { generate, approvedServers, PRODUCTS: Object.keys(PRODUCTS) };
