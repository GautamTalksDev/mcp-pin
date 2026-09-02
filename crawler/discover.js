'use strict';
/*
 * Discovery. Each source returns { id, name, source, install } records.
 * Sources are independent and failure-isolated: one being down or blocked
 * must never stop a crawl.
 */
const { sha256 } = require('../src/canonical');
const { safeFetch, LIMITS } = require('./security');

const UA = 'mcp-pin-crawler/0.1 (+https://github.com/GautamTalksDev/mcp-pin)';

async function getJSON(url, timeoutMs = 15000) {
  const { res, text } = await safeFetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } }, { timeoutMs, maxBytes: LIMITS.MAX_HTTP_BYTES });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return JSON.parse(text);
}

function serverId(kind, key) {
  return sha256(`${kind}:${key}`).slice(0, 16);
}

// npm: packages keyworded mcp / mcp-server. This is the largest reachable
// source and the one most likely to be installed by real users.
async function fromNpm(limit = 250) {
  const out = [];
  const seen = new Set();
  for (const q of ['keywords:mcp-server', 'keywords:modelcontextprotocol', 'keywords:mcp']) {
    for (let from = 0; from < limit; from += 250) {
      let page;
      try {
        page = await getJSON(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=250&from=${from}`);
      } catch {
        break;
      }
      if (!page.objects || !page.objects.length) break;
      for (const o of page.objects) {
        const p = o.package;
        if (seen.has(p.name)) continue;
        seen.add(p.name);
        out.push({
          id: serverId('npm', p.name),
          name: p.name,
          source: 'npm',
          description: p.description || '',
          homepage: (p.links && (p.links.repository || p.links.npm)) || '',
          install: { type: 'stdio', command: 'npx', args: ['-y', p.name] },
        });
      }
      if (page.objects.length < 250) break;
    }
  }
  return out;
}

// Official MCP registry. Shape may drift; treat failure as non-fatal.
async function fromMcpRegistry(limit = 500) {
  const out = [];
  try {
    let cursor = null;
    while (out.length < limit) {
      const url = 'https://registry.modelcontextprotocol.io/v0/servers' + (cursor ? `?cursor=${cursor}` : '');
      const page = await getJSON(url);
      const items = page.servers || page.data || [];
      for (const s of items) {
        const name = s.name || s.id;
        if (!name) continue;
        const remote = (s.remotes && s.remotes[0]) || null;
        out.push({
          id: serverId('registry', name),
          name,
          source: 'mcp-registry',
          description: s.description || '',
          homepage: (s.repository && s.repository.url) || '',
          install: remote
            ? { type: 'http', url: remote.url }
            : { type: 'stdio', command: 'npx', args: ['-y', name] },
        });
      }
      cursor = page.metadata && page.metadata.next_cursor;
      if (!cursor || !items.length) break;
    }
  } catch (e) {
    process.stderr.write(`discover: mcp-registry unavailable (${e.message})\n`);
  }
  return out;
}

// GitHub topic mcp-server. Unauthenticated is rate-limited to 60/hr; set
// GITHUB_TOKEN in CI.
async function fromGitHubTopic(pages = 3) {
  const out = [];
  const headers = { 'user-agent': UA, accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  for (let p = 1; p <= pages; p++) {
    try {
      const { res: r, text } = await safeFetch(`https://api.github.com/search/repositories?q=topic:mcp-server&per_page=100&page=${p}`, { headers }, { timeoutMs: 15000 });
      if (!r.ok) break;
      const j = JSON.parse(text);
      for (const repo of j.items || []) {
        if (!repo || typeof repo.full_name !== 'string') continue;
        out.push({
          id: serverId('github', repo.full_name),
          name: repo.full_name,
          source: 'github',
          description: repo.description || '',
          homepage: repo.html_url,
          install: { type: 'unknown' },
        });
      }
      if (!j.items || j.items.length < 100) break;
    } catch {
      break;
    }
  }
  return out;
}

async function discover(opts = {}) {
  const results = await Promise.allSettled([
    opts.npm !== false ? fromNpm(opts.limit || 250) : [],
    opts.registry !== false ? fromMcpRegistry() : [],
    opts.github === true ? fromGitHubTopic() : [],
  ]);
  const all = [];
  const seen = new Set();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const s of r.value) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      all.push(s);
    }
  }
  return all;
}

module.exports = { discover, fromNpm, fromMcpRegistry, fromGitHubTopic, serverId };
