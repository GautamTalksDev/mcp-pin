#!/usr/bin/env node
'use strict';
/*
 * Static site build. node site/build.js [--data DIR] [--out DIR]
 * Emits: index.html, servers/<id>.html, badge/<id>.svg, feed/<id>.xml,
 *        log.ndjson, head.json, api/servers.json
 */
const fs = require('fs');
const path = require('path');
const { PublicLog } = require('../crawler/log');
const { badgeFor, days } = require('../crawler/badge');
const { renderToolDiff } = require('../src/diff');
const { safeId } = require('../crawler/security');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const DATA = path.resolve(flag('--data', 'data'));
const OUT = path.resolve(flag('--out', 'public'));
const SITE = process.env.SITE_URL || 'https://mcp-pin.gautamkhosla.com';

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

const CSS = `
:root{--bg:#0d1117;--fg:#e6edf3;--dim:#8b949e;--line:#30363d;--card:#161b22;--grn:#3fb950;--amb:#d29922;--red:#f85149;--acc:#58a6ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 ui-sans-serif,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:32px 20px 80px}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:26px;margin:0 0 6px}h2{font-size:18px;margin:32px 0 12px;border-bottom:1px solid var(--line);padding-bottom:8px}
.sub{color:var(--dim);margin:0 0 28px}
.row{display:flex;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid var(--line);border-radius:8px;background:var(--card);margin-bottom:8px;align-items:center}
.nm{font-weight:600}.meta{color:var(--dim);font-size:13px}
.pill{font-size:12px;padding:2px 9px;border-radius:99px;white-space:nowrap}
.g{background:rgba(63,185,80,.15);color:var(--grn)}.a{background:rgba(210,153,34,.15);color:var(--amb)}.r{background:rgba(248,81,73,.15);color:var(--red)}
pre{background:#010409;border:1px solid var(--line);border-radius:8px;padding:14px;overflow-x:auto;font-size:12.5px;line-height:1.5}
.add{color:var(--grn)}.del{color:var(--red)}.ctx{color:var(--dim)}
code{background:#010409;padding:2px 6px;border-radius:4px;font-size:13px}
.stats{display:flex;gap:24px;flex-wrap:wrap;color:var(--dim);font-size:13px;margin-bottom:24px}
.stats b{color:var(--fg);font-size:20px;display:block}
input{width:100%;padding:10px 14px;background:var(--card);border:1px solid var(--line);border-radius:8px;color:var(--fg);margin-bottom:16px;font-size:14px}
.foot{margin-top:60px;color:var(--dim);font-size:13px;border-top:1px solid var(--line);padding-top:20px}
`;

function page(title, body) {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title><style>${CSS}</style><div class="wrap">${body}
<div class="foot">mcp-pin — a public record of MCP tool definitions over time.
Every entry is hash-linked; <a href="/log.ndjson">download the log</a> and verify it offline with
<code>npx mcp-pin verify-log</code>. <a href="https://github.com/GautamTalksDev/mcp-pin">source</a></div></div></html>`;
}

function pill(s) {
  if (!s.set_hash) return '<span class="pill">unknown</span>';
  if (!s.last_change_at) { const t = days(s.first_seen_at); return `<span class="pill g">${t < 1 ? 'tracking started' : 'unchanged ' + t + 'd'}</span>`; }
  const d = days(s.last_change_at);
  if (d < 1) return '<span class="pill r">changed today</span>';
  if (d <= 7) return `<span class="pill a">changed ${d}d ago</span>`;
  return `<span class="pill g">unchanged ${d}d</span>`;
}

function diffHtml(oldC, newC, name) {
  const raw = strip(renderToolDiff(name, oldC, newC));
  return raw.split('\n').map((l) => {
    const c = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx';
    return `<span class="${c}">${esc(l)}</span>`;
  }).join('\n');
}

(function main() {
  const log = new PublicLog(DATA);
  const state = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8')); } catch { return { servers: {} }; } })();
  const servers = Object.values(state.servers).filter((s) => s.set_hash);
  const entries = log.entries();

  fs.mkdirSync(path.join(OUT, 'servers'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'badge'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'feed'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'api'), { recursive: true });

  // copy the verifiable artifacts
  for (const f of ['log.ndjson', 'head.json']) {
    const p = path.join(DATA, f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(OUT, f));
  }

  const byChange = servers.slice().sort((a, b) => new Date(b.last_change_at || 0) - new Date(a.last_change_at || 0));
  const recent = byChange.filter((s) => s.last_change_at && days(s.last_change_at) <= 30);

  // ---- index
  const rows = byChange.map((s) => `<div class="row"><div><div class="nm"><a href="/servers/${s.id}.html">${esc(s.name)}</a></div>
<div class="meta">${esc((s.description || '').slice(0, 110))}</div></div>
<div style="text-align:right"><div>${pill(s)}</div><div class="meta">${s.tool_count} tools</div></div></div>`).join('\n');

  fs.writeFileSync(path.join(OUT, 'index.html'), page('mcp-pin — public log of MCP tool definitions', `
<h1>mcp-pin</h1>
<p class="sub">A public, append-only record of what every MCP server's tools looked like, and when they changed.
Your client asks you to approve a server once. It never checks again.</p>
<div class="stats">
<div><b>${servers.length}</b>servers tracked</div>
<div><b>${entries.length}</b>log entries</div>
<div><b>${recent.length}</b>changed in 30 days</div>
</div>
<input id="q" placeholder="filter servers…" oninput="for(const r of document.querySelectorAll('.row'))r.style.display=r.innerText.toLowerCase().includes(this.value.toLowerCase())?'':'none'">
<h2>Servers</h2>${rows || '<p class="sub">No servers recorded yet. Run the crawler.</p>'}`));

  // ---- per server
  for (const s of servers) {
    if (!safeId(s.id)) { process.stderr.write(`skipping server with unsafe id\n`); continue; }
    const hist = log.history(s.id);
    const latest = hist[hist.length - 1];
    let changes = '';
    for (let i = hist.length - 1; i > 0; i--) {
      const cur = hist[i], prv = hist[i - 1];
      const prevByName = new Map(prv.tools.map((t) => [t.name, t]));
      const parts = [];
      for (const t of cur.tools) {
        const o = prevByName.get(t.name);
        if (!o) parts.push(`<p class="add">+ tool added: ${esc(t.name)}</p>`);
        else if (o.hash !== t.hash) parts.push(`<pre>${diffHtml(o.canonical_json, t.canonical_json, t.name)}</pre>`);
      }
      const curNames = new Set(cur.tools.map((t) => t.name));
      for (const t of prv.tools) if (!curNames.has(t.name)) parts.push(`<p class="del">− tool removed: ${esc(t.name)}</p>`);
      changes += `<h2>Changed ${esc(cur.observed_at.slice(0, 10))}</h2>${parts.join('\n') || '<p class="meta">metadata changed</p>'}`;
    }

    const toolList = (latest ? latest.tools : []).map((t) => `<div class="row"><div class="nm">${esc(t.name)}</div><div class="meta">${esc(t.hash.slice(0, 16))}</div></div>`).join('\n');
    const snippet = `[![mcp-pin](${SITE}/badge/${s.id}.svg)](${SITE}/servers/${s.id}.html)`;

    fs.writeFileSync(path.join(OUT, 'servers', s.id + '.html'), page(`${s.name} — mcp-pin`, `
<h1>${esc(s.name)}</h1>
<p class="sub">${esc(s.description || '')}</p>
<div class="stats">
<div><b>${s.tool_count}</b>tools</div>
<div><b>${hist.length}</b>recorded versions</div>
<div><b>${days(s.first_seen_at)}d</b>tracked</div>
<div>${pill(s)}</div>
</div>
<p class="meta">source: ${esc(s.source)} · fingerprint <code>${esc(s.set_hash.slice(0, 24))}</code>
${s.homepage ? ` · <a href="${esc(s.homepage)}">homepage</a>` : ''} · <a href="/feed/${s.id}.xml">RSS</a></p>
<h2>Badge</h2><p><img src="/badge/${s.id}.svg" alt="badge"></p><pre>${esc(snippet)}</pre>
<h2>Current tools</h2>${toolList}
${changes || '<h2>History</h2><p class="meta">No changes recorded since tracking began.</p>'}`));

    fs.writeFileSync(path.join(OUT, 'badge', s.id + '.svg'), badgeFor(s));

    const items = log.history(s.id).slice().reverse().slice(0, 20).map((e) => `<item><title>${esc(s.name)} tools changed</title>
<link>${SITE}/servers/${s.id}.html</link><guid isPermaLink="false">${e.entry_hash}</guid>
<pubDate>${new Date(e.observed_at).toUTCString()}</pubDate>
<description>${esc(e.tools.map((t) => t.name).join(', '))}</description></item>`).join('\n');
    fs.writeFileSync(path.join(OUT, 'feed', s.id + '.xml'),
      `<?xml version="1.0"?><rss version="2.0"><channel><title>mcp-pin: ${esc(s.name)}</title>
<link>${SITE}/servers/${s.id}.html</link><description>Tool definition changes</description>${items}</channel></rss>`);
  }

  fs.writeFileSync(path.join(OUT, 'api', 'servers.json'), JSON.stringify(servers, null, 2));
  process.stderr.write(`built ${servers.length} server pages into ${OUT}\n`);
})();
