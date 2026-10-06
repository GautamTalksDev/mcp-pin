#!/usr/bin/env node
'use strict';
/*
 * Static site build. node site/build.js [--data DIR] [--out DIR]
 *
 * Design: one dark stage and one red, with the type and stills of DRIFT, the film about
 * mcp-pin, and Pin from the reels. The design system is site/ui (theme.css, site.js,
 * home.js); fonts and media are self-hosted, so the CSP allows nothing from elsewhere.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PublicLog } = require('../crawler/log');
const { badgeFor, status, between, days, WIDE_WINDOW_DAYS } = require('../crawler/badge');
// Install commands on the site follow the version in package.json.
const PKG = 'mcp-pin@' + require('../package.json').version;
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const longDate = (iso) => { const d = new Date(iso); return `${d.getUTCDate()} ${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
// A change seen after a gap cannot be dated to the day it happened.
const wideChange = (s) => !!(s.last_change_at && s.last_change_after &&
  between(s.last_change_after, s.last_change_at) > WIDE_WINDOW_DAYS);

// Under a day, "0d" reads like a bug next to "changed today". Show hours.
function span(fromISO) {
  const ms = Date.now() - new Date(fromISO).getTime();
  const d = Math.floor(ms / 86400000);
  if (d >= 1) return d + 'd';
  const h = Math.floor(ms / 3600000);
  return h >= 1 ? h + 'h' : Math.max(1, Math.floor(ms / 60000)) + 'm';
}
const { renderToolDiff } = require('../src/diff');
const { safeId } = require('../crawler/security');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const DATA = path.resolve(flag('--data', 'data'));
const OUT = path.resolve(flag('--out', 'public'));
const SITE = process.env.SITE_URL || 'https://mcp-pin.gautamkhosla.com';
const REPO = 'https://github.com/GautamTalksDev/mcp-pin';

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

const DESC = 'mcp-pin remembers what every MCP server told your AI the day you approved it, and stops the session when that changes. Plus a signed public log of every version.';
// Fonts, media, styles and script are served from this site only, these pages
// run no inline script, and no string can reach an HTML sink (Trusted Types);
// the CSP says so. The header policy in _headers matches, plus the hashes of
// the two self-contained pages' inline scripts.
const CSP = "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; media-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types 'none'";
const version = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'ui', rel))).digest('hex').slice(0, 10);
const V = { css: version('theme.css'), js: version('site.js') };
const FILM = 'https://www.youtube.com/watch?v=tGtbDNr9qvE';

function nav(current) {
  const link = (href, label) => `<a href="${href}"${current === href ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<nav class="nav" aria-label="Main"><div class="wrap">
<a class="brand" href="/" aria-label="mcp-pin, home"><img src="/logo.svg" width="28" height="28" alt="">mcp-pin</a>
<div class="nav-links">${link('/#how', 'How it works')}${link('/log/', 'Public log')}${link('/reports/', 'Reports')}${link('/#teams', 'Teams')}${link(REPO, 'GitHub')}</div>
<button class="menu" type="button" aria-expanded="false">Menu</button>
<a class="btn btn-primary" href="/install/">Install</a>
</div></nav>`;
}

function footer() {
  return `<footer class="footer"><div class="wrap">
<div class="cols">
<div><a class="brand" href="/"><img src="/logo.svg" width="28" height="28" alt="">mcp-pin</a>
<p style="margin:18px 0 0;max-width:34ch">Pin what your agent approved. Block it when it changes.</p></div>
<div><h4>Product</h4><ul><li><a href="/install/">Install</a></li><li><a href="/log/">Public log</a></li><li><a href="/reports/">Drift reports</a></li><li><a href="/spot/">Spot the rug pull</a></li></ul></div>
<div><h4>Docs</h4><ul><li><a href="${REPO}#readme">README</a></li><li><a href="${REPO}/blob/main/docs/TOOL_DEFINITION_HASH.md">Tool definition hash</a></li><li><a href="${REPO}/blob/main/docs/VERIFYING.md">Verify the log</a></li><li><a href="${REPO}/blob/main/SECURITY.md">Security</a></li></ul></div>
<div><h4>Project</h4><ul><li><a href="/about.html">About</a></li><li><a href="${FILM}">The film</a></li><li><a href="${REPO}">GitHub</a></li><li><a href="${REPO}/blob/main/CHANGELOG.md">Changelog</a></li></ul></div>
</div>
<div class="fine">
<p>mcp-pin keeps a public, append-only record of MCP tool definitions. Every entry is hash linked and every head is signed, so you can <a class="link" href="/log.ndjson">download the log</a> and check it yourself with <code><!--email_off-->npx -y ${PKG} verify-log<!--/email_off--></code>. The verifier pins <a class="link" href="/PUBLIC_KEY.txt">PUBLIC_KEY.txt</a>; it will not accept a head signed by whatever key arrives with the file.</p>
<p>Crawling follows <code>tools/list</code> pagination, capped at 50 pages, once per server per day. No tool is ever called. To opt out, add your server to <a class="link" href="${REPO}/blob/main/OPTOUT.txt">OPTOUT.txt</a> or open an issue. Honoured on the next crawl, no justification needed.</p>
<p>Run by Gautam Khosla as an independent open-source project. Not affiliated with Anthropic, the Model Context Protocol project, or any server listed here. <a class="link" href="/about.html">About this project, and how to contact me</a>. MIT licensed.</p>
</div></div></footer>`;
}

function page(title, body, opts = {}) {
  const url = SITE + (opts.path || '/');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#0b0a09">
<title>${esc(title)}</title>
<meta name="description" content="${esc(opts.desc || DESC)}">
<link rel="canonical" href="${url}">
<link rel="icon" type="image/svg+xml" href="/logo.svg">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(opts.desc || DESC)}">
<meta property="og:type" content="website">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="You approved it once. Then it changed. Pin, the mcp-pin mascot, reads the headline.">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary_large_image">
<link rel="preload" href="/fonts/fraunces.woff" as="font" type="font/woff" crossorigin>
<link rel="preload" href="/fonts/hanken.woff" as="font" type="font/woff" crossorigin>
<link rel="stylesheet" href="/assets/site.css?v=${V.css}">
<script src="/assets/site.js?v=${V.js}" defer></script>
</head><body>
<a class="skip" href="#main">Skip to content</a>
${nav(opts.path)}
${body}
${footer()}
</body></html>`;
}

// A plain page header: eyebrow, display title, lede.
const head = (eyebrow, title, lede) => `<div class="page-head"><div class="wrap">
${eyebrow ? `<p class="eyebrow">${eyebrow}</p>` : ''}<h1 class="display">${title}</h1>${lede ? `<p class="lede">${lede}</p>` : ''}
</div></div>`;

// Same rules as the badge, so the page and the badge can never disagree.
const PILL = { green: 'pg', amber: 'pa', red: 'pr', grey: 'px' };
function pill(s) {
  const st = status(s);
  return `<span class="pill ${PILL[st.color]}">${esc(st.text)}</span>`;
}

function diffHtml(oldC, newC, name) {
  return strip(renderToolDiff(name, oldC, newC)).split('\n').map((l) => {
    const c = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx';
    return `<span class="${c}">${esc(l)}</span>`;
  }).join('\n');
}

// Registry metadata carries git+https://….git, which is not a link a human
// wants to click. Normalise it.
function homeUrl(u) {
  if (!u) return '';
  return String(u).replace(/^git\+/, '').replace(/\.git$/, '').replace(/^ssh:\/\/git@/, 'https://');
}

// One line a person can read before any diff: what actually moved.
function changeSummary(prev, cur) {
  const prevByName = new Map(prev.tools.map((t) => [t.name, t]));
  let text = 0, schema = 0, added = 0, removed = 0;
  for (const t of cur.tools) {
    const o = prevByName.get(t.name);
    if (o === undefined) { added++; continue; }
    if (o.hash === t.hash) continue;
    const od = JSON.parse(o.canonical_json).description || '';
    const nd = JSON.parse(t.canonical_json).description || '';
    if (od === nd) schema++; else text++;
  }
  const curNames = new Set(cur.tools.map((t) => t.name));
  for (const t of prev.tools) if (curNames.has(t.name) === false) removed++;

  const bits = [];
  if (text) bits.push(`${text} description${text === 1 ? '' : 's'} rewritten`);
  if (schema) bits.push(`<strong>${schema} schema or annotation change${schema === 1 ? '' : 's'} with the description left byte-identical</strong>`);
  if (added) bits.push(`${added} tool${added === 1 ? '' : 's'} added`);
  if (removed) bits.push(`${removed} tool${removed === 1 ? '' : 's'} removed`);
  return { line: bits.join(', '), schema, total: text + schema + added + removed };
}


(function main() {
  const log = new PublicLog(DATA);
  const state = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8')); }
    catch { return { servers: {} }; }
  })();
  const servers = Object.values(state.servers).filter((s) => s.set_hash);
  const entries = log.entries();
  const totalTools = servers.reduce((a, s) => a + (s.tool_count || 0), 0);

  for (const d of ['servers', 'badge', 'feed', 'api', 'assets', 'log']) fs.mkdirSync(path.join(OUT, d), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'ui', 'theme.css'), path.join(OUT, 'assets', 'site.css'));
  fs.copyFileSync(path.join(__dirname, 'ui', 'site.js'), path.join(OUT, 'assets', 'site.js'));
  for (const d of ['fonts', 'media']) {
    const src = path.join(__dirname, d);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(OUT, d), { recursive: true });
  }
  fs.copyFileSync(path.join(__dirname, 'logo.svg'), path.join(OUT, 'logo.svg'));
  const og = path.join(__dirname, 'og.png');
  if (fs.existsSync(og)) fs.copyFileSync(og, path.join(OUT, 'og.png'));
  const version = require('../package.json').version;
  // The self-contained pages, with commands that follow the version in
  // package.json. Their inline scripts are kept for the header CSP below.
  const inlineScripts = [];
  const selfContained = (dir) => {
    fs.mkdirSync(path.join(OUT, dir), { recursive: true });
    const src = path.join(__dirname, dir, 'index.html');
    if (!fs.existsSync(src)) return;
    const html = fs.readFileSync(src, 'utf8').split('__MCP_PIN_VERSION__').join(version);
    fs.writeFileSync(path.join(OUT, dir, 'index.html'), html);
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) inlineScripts.push(m[1]);
  };
  // Spot the rug pull: a static, self-contained page with its own share image.
  selfContained('spot');
  if (fs.existsSync(path.join(__dirname, 'spot', 'og.png'))) fs.copyFileSync(path.join(__dirname, 'spot', 'og.png'), path.join(OUT, 'spot', 'og.png'));
  // Install page: one command, one-click buttons, and a generator for server authors.
  selfContained('install');
  // log.ndjson outgrew Cloudflare Pages' 25 MiB per-file limit on 5 Oct 2026 (26.4 MiB),
  // which failed every deploy. site/_redirects sends /log.ndjson and /head.json to the
  // same two files in the repository, so a verifier always gets a log and head from one commit.
  for (const f of ['pagination-recrawl.json', 'incomplete-crawl-2026-09-04.json', 'env-conditioned-listings-2026-09-04.json', 'controlled-recrawl-2026-09-04.json']) {
    const p = path.join(DATA, f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(OUT, f));
  }
  const pubKey = path.join(__dirname, '..', 'PUBLIC_KEY.txt');
  if (fs.existsSync(pubKey)) fs.copyFileSync(pubKey, path.join(OUT, 'PUBLIC_KEY.txt'));

  const byChange = servers.slice().sort((a, b) =>
    new Date(b.last_change_at || 0) - new Date(a.last_change_at || 0));
  const recent = byChange.filter((s) => s.last_change_at && days(s.last_change_at) <= 30);
  // The strongest single link on the page: a server that actually moved.
  const newest = byChange.find((s) => s.last_change_at) || null;
  // A change first seen today after a gap did not necessarily happen today.
  const last24 = byChange.filter((s) => s.last_change_at && !wideChange(s) &&
    Date.now() - new Date(s.last_change_at).getTime() <= 86400000).length;
  const gap = byChange.filter((s) => wideChange(s) && days(s.last_change_at) <= 30);
  const gapFrom = gap.length ? gap.map((s) => s.last_change_after).sort()[0] : null;
  const gapTo = gap.length ? gap.map((s) => s.last_change_at).sort().slice(-1)[0] : null;

  const rows = byChange.map((s) => `<div class="row" data-name="${esc(String(s.name).toLowerCase())}">
<div><div class="nm"><a href="/servers/${s.id}.html">${esc(s.name)}</a></div>
<div class="meta">${esc((s.description || '').slice(0, 96))}</div></div>
<div class="right">${pill(s)}<div class="meta">${s.tool_count} tools</div></div></div>`).join('\n');

  // ------------------------------------------------------------- index: the story
  const home = require('./ui/home');
  fs.writeFileSync(path.join(OUT, 'index.html'), page('mcp-pin: you approved it once. Then it changed.', home({
    esc, PKG, REPO,
    stats: { servers: servers.length, tools: totalTools, changed30: recent.length, gapCount: gap.length,
      gapFrom: gapFrom && longDate(gapFrom), gapTo: gapTo && longDate(gapTo) },
  }), { path: '/' }));

  // ------------------------------------------------------------- the public log
  fs.writeFileSync(path.join(OUT, 'log', 'index.html'), page('The public log of MCP tool definitions', `
<main id="main">
${head('The public log', 'Every version,<br><em>on the record.</em>', `What public MCP servers&rsquo; tools said, and when it changed. Signed, append-only, and checkable by anyone with <code><!--email_off-->npx -y ${PKG} verify-log<!--/email_off--></code>.`)}
<div class="wrap">
  <div class="facts">
    <div class="fact"><b>${servers.length}</b><span>servers tracked</span></div>
    <div class="fact"><b>${totalTools.toLocaleString('en-US')}</b><span>tool definitions recorded</span></div>
    <div class="fact"><b>${entries.length.toLocaleString('en-US')}</b><span>log entries</span></div>
    <div class="fact"><b>${last24}</b><span>changed in the last 24 hours</span></div>
  </div>
  <div class="doc">
  ${gap.length ? `<p class="note">When the crawler resumed on ${esc(longDate(gapTo))} after a pause,
  ${gap.length} server${gap.length === 1 ? ' had' : 's had'} changed since it last looked at them, as early as ${esc(longDate(gapFrom))}.
  The day each change happened is unknown, so those servers read <em>changed since</em> a date
  instead of <em>changed today</em>. <a href="/about.html#paused">Why the crawler paused</a></p>` : ''}
  <p class="note">On 4 September 2026 every recorded server was re-probed with a crawler that follows
  <code>tools/list</code> pagination. 18 of 248 had a higher tool count; 0 of those 18 currently
  return <code>nextCursor</code>. The extra tools were on page 1.
  The 10:53 UTC signed head that day covers a <em>failed</em> crawl that still signed
  (<a href="/incomplete-crawl-2026-09-04.json">note</a>).
  <a href="/about.html">What that means</a> · <a href="/pagination-recrawl.json">the numbers</a></p>
  <h2 id="the-record">The record</h2>
  <label for="q" class="sr">Filter servers by name</label>
  <input id="q" class="search" type="search" placeholder="Filter by name, for example firecrawl" autocomplete="off" spellcheck="false">
  <p class="small" id="qcount" aria-live="polite">${servers.length} servers</p>
  ${rows || '<p class="note">No servers recorded yet. The crawler runs daily.</p>'}
  </div>
</div>
</main>`, { desc: 'A signed, append-only history of what public MCP servers told AI clients, and when it changed.', path: '/log/' }));

  // -------------------------------------------------------- server pages
  for (const s of servers) {
    if (!safeId(s.id)) { process.stderr.write('skipping server with unsafe id\n'); continue; }
    const hist = log.history(s.id);
    const latest = hist[hist.length - 1];

    let changes = '';
    let headline = '';
    for (let i = hist.length - 1; i > 0; i--) {
      const cur = hist[i], prv = hist[i - 1];
      const prevByName = new Map(prv.tools.map((t) => [t.name, t]));
      const sum = changeSummary(prv, cur);
      if (i === hist.length - 1) headline = sum;
      const parts = [];
      for (const t of cur.tools) {
        const o = prevByName.get(t.name);
        if (!o) parts.push(`<p class="add">+ tool added: ${esc(t.name)}</p>`);
        else if (o.hash !== t.hash) parts.push(`<pre>${diffHtml(o.canonical_json, t.canonical_json, t.name)}</pre>`);
      }
      const curNames = new Set(cur.tools.map((t) => t.name));
      for (const t of prv.tools) if (!curNames.has(t.name)) parts.push(`<p class="del">tool removed: ${esc(t.name)}</p>`);
      const seenAt = esc(cur.observed_at.slice(0, 16).replace('T', ' ')) + ' UTC';
      // Only the latest change has its window in state; after a gap, say so.
      const when = i === hist.length - 1 && wideChange(s)
        ? `between ${esc(longDate(s.last_change_after))} and ${esc(longDate(s.last_change_at))} (first seen ${seenAt})`
        : seenAt;
      changes += `<h3 style="margin-top:36px">Changed ${when}</h3>`;
      if (sum.line) changes += `<p class="changed-summary">${sum.line}.</p>`;
      changes += parts.join('\n') || '<p class="body">Metadata changed.</p>';
    }

    const toolList = (latest ? latest.tools : []).map((t) =>
      `<div class="row"><div class="nm">${esc(t.name)}</div>
<div class="right meta" style="font-family:var(--mono)">${esc(t.hash.slice(0, 16))}</div></div>`).join('\n');
    const snippet = `[![mcp-pin](${SITE}/badge/${s.id}.svg)](${SITE}/servers/${s.id}.html)`;

    fs.writeFileSync(path.join(OUT, 'servers', s.id + '.html'), page(
      `${s.name} on mcp-pin`,
      `<main id="main"><div class="page-head"><div class="wrap">
<p class="eyebrow"><a href="/log/">Public log</a></p>
<h1 class="display" style="font-size:clamp(2.2rem,5.2vw,4.4rem);max-width:22ch;overflow-wrap:anywhere">${esc(s.name)}</h1>
<p class="lede">${esc(s.description || 'No description published.')}</p>
<p class="cmd">${esc(s.source)} · fingerprint ${esc(s.set_hash.slice(0, 24))}${s.homepage ? ` · <a href="${esc(homeUrl(s.homepage))}">repository</a>` : ''} · <a href="/feed/${s.id}.xml">RSS</a></p>
</div></div>
<div class="wrap"><div class="facts">
<div class="fact"><b>${s.tool_count}</b><span>tools</span></div>
<div class="fact"><b>${hist.length}</b><span>recorded versions</span></div>
<div class="fact"><b>${span(s.first_seen_at)}</b><span>tracked</span></div>
<div class="fact" style="padding-top:38px">${pill(s)}</div>
</div>
<section class="doc">
${changes
  ? `<h2>What changed</h2>${changes}`
  : '<h2>What changed</h2><p class="body">Nothing, since tracking began. That is the good outcome, and it is what most servers look like.</p>'}

<h2 style="margin-top:56px">Current tools</h2>
<details><summary>Show all ${s.tool_count} tool fingerprints</summary>
<div style="margin-top:14px">${toolList}</div>
</details>

<h2 style="margin-top:56px">Watch this server yourself</h2>
<p class="body">If you run this server, put the proxy in front of it. It pins these exact
fingerprints on first connect and stops the session if they move.</p>
<pre><!--email_off-->npx -y ${PKG} -- &lt;your ${esc(s.name)} command&gt;<!--/email_off--></pre>
<p class="body" style="margin-top:18px">Or subscribe to this page's <a href="/feed/${s.id}.xml">RSS feed</a>
to be told when it changes.</p>

<h2 style="margin-top:56px">Badge</h2>
<p><img src="/badge/${s.id}.svg" alt="mcp-pin status badge for ${esc(s.name)}"></p>
<p class="body">The badge states one fact about time and nothing else. It never claims a
server is safe.</p>
<pre>${esc(snippet)}</pre>
</section></div></main>`,
      { desc: `Tool definition history for ${s.name}.`, path: `/servers/${s.id}.html` }));

    fs.writeFileSync(path.join(OUT, 'badge', s.id + '.svg'), badgeFor(s));

    const items = hist.slice().reverse().slice(0, 20).map((e) =>
      `<item><title>${esc(s.name)} tools changed</title>
<link>${SITE}/servers/${s.id}.html</link><guid isPermaLink="false">${e.entry_hash}</guid>
<pubDate>${new Date(e.observed_at).toUTCString()}</pubDate>
<description>${esc(e.tools.map((t) => t.name).join(', '))}</description></item>`).join('\n');
    fs.writeFileSync(path.join(OUT, 'feed', s.id + '.xml'),
      `<?xml version="1.0"?><rss version="2.0"><channel><title>mcp-pin: ${esc(s.name)}</title>
<link>${SITE}/servers/${s.id}.html</link><description>Tool definition changes</description>${items}</channel></rss>`);
  }

  // ------------------------------------------------------------ about
  fs.writeFileSync(path.join(OUT, 'about.html'), page('About mcp-pin', `
<main id="main"><div class="page-head"><div class="wrap">
<p class="eyebrow">About</p>
<h1 class="display">About this <em>project</em></h1>
<p class="lede">mcp-pin is an independent open-source project built and run by
<a href="https://github.com/GautamTalksDev">Gautam Khosla</a>, a student. It is not affiliated with,
endorsed by, or connected to Anthropic, the Model Context Protocol project, npm, GitHub,
or any of the servers listed in the log.</p>
</div></div>
<div class="wrap narrow"><section class="doc">
<h2>What this site publishes</h2>
<p class="body">A record of the tool metadata that public MCP servers return when asked.
Names, descriptions, input schemas, and annotations, along with a cryptographic hash of each
and the date it was observed. All of it is information those servers publish openly to any
client that connects.</p>
<p class="body">Nothing here is a security assessment. A badge reading
<em>unchanged 91d</em> means the fingerprint has not moved in 91 days. It does not mean a
server is safe, well written, or trustworthy, and it should never be read that way.</p>

<h2 style="margin-top:52px">Pagination recrawl, 4 September 2026</h2>
<p class="body">Versions of the crawler at 0.1.0 and earlier issued one <code>tools/list</code> and
ignored <code>nextCursor</code>. That is a real bug. A truncated server would have shown a stable
badge against an incomplete toolset. On 4 September 2026 every server already in the log
was re-probed with a crawler that follows pagination.</p>
<p class="body"><strong>18 of 248 recorded servers had a higher tool count. 0 of those 18 currently
return <code>nextCursor</code></strong>: the extra tools were already on page 1. The count changes are
not pagination recovery: none of the 18 returns <code>nextCursor</code>. A controlled re-probe on
4 September reproduced all 18 counts exactly, so they are stable rather than probe noise.
For 17 of them the increase is ordinary package drift between crawls. One,
<code>@novalux12/spotify-mcp</code>, is still unexplained; see below. Five servers failed the
re-probe and are unknown. Historical responses did not store <code>nextCursor</code> or probe env.
The machine-readable
record is <a href="/pagination-recrawl.json">pagination-recrawl.json</a>) and <a href="/controlled-recrawl-2026-09-04.json">controlled-recrawl-2026-09-04.json</a>.</p>
<p class="body">A signed log that quietly corrected itself would be worse than one that did not
need correcting. Publishing this is the correction.</p>

<h2 style="margin-top:52px">Incomplete crawl, 4 September 2026 10:53 UTC</h2>
<p class="body">The signed head at <code>52d6ac1</code> (<code>tree_size</code> 281, signed 10:53 UTC) was produced
by a <em>failed</em> scheduled crawl. The Crawl step failed; Sign, Verify, and Commit still ran
because those steps used <code>if: always()</code> in a single job that also executed untrusted
packages. Eighteen entries were appended. <code>last-crawl.json</code> was not updated. The chain
verifies; the coverage does not. The log was not rewritten. Machine-readable note:
<a href="/incomplete-crawl-2026-09-04.json">incomplete-crawl-2026-09-04.json</a>.</p>

<h2 style="margin-top:52px">Tool listings recorded without their environment</h2>
<p class="body">Some MCP servers choose which tools to register based on environment variables.
<code>@novalux12/spotify-mcp</code> reads <code>SPOTIFY_MCP_TOOLSETS</code>: unset or <code>all</code> registers 551 tools,
<code>playback,library</code> registers 207, and an unrecognised value registers 4. The crawler did not
record the environment a probe ran with, so a tool count in this log cannot be read as the
server&rsquo;s full surface, only as what the server exposed to one probe.</p>
<p class="body">A second defect compounds it. When a server reports that it needs environment
variables, the probe retried with the literal string <code>mcp-pin-probe-placeholder</code> for each one.
The detector did not distinguish credentials from feature flags, so a placeholder could be
written into a variable that selects which tools register.</p>
<p class="body"><strong>One case is unresolved.</strong> Entry 60 (3 September 2026) records 50 tools for
<code>@novalux12/spotify-mcp</code>. No published version of that package exposes 50 tools under any
toolset value reproduced on 4 September: published versions expose 96, 99, 100, 101, 154,
313, 550 or 551, and the placeholder value exposes 4. All 50 logged names are a subset of the
551. The mechanism that produced 50 is unknown, and it is recorded here as unknown rather
than explained away. Machine-readable note:
<a href="/env-conditioned-listings-2026-09-04.json">env-conditioned-listings-2026-09-04.json</a>.</p>

<h2 id="paused" style="margin-top:52px">Crawl paused, 4 September to 5 October 2026</h2>
<p class="body">The daily crawl was switched off on 4 September 2026 because of the two problems
above: listings did not record the environment they were taken under, and placeholders could reach
variables that decide which tools register. It was switched back on on 5 October 2026, once placeholders
could only reach credential-shaped variables. The crawler also passed each listing's probe environment to the
log by then, but the log dropped that field until 0.2.0, so the entries of 5 October do not have it. The
<a href="${REPO}/blob/main/CHANGELOG.md">changelog</a> records the correction.</p>
<p class="body">Nothing was observed in between. A change first seen when the crawl resumed could have
happened on any day of that gap, so it reads <em>changed since 4 Sep</em>, not <em>changed today</em>.
Badges also stop counting when the crawler stops looking: a server that has not been checked for more
than three days reads <em>last checked</em> and a date, never a number that kept growing while nobody
looked.</p>

<h2 style="margin-top:52px">What this does not protect against</h2>
<p class="body">mcp-pin detects when a server's tool definitions change between sessions,
including changes the server did not announce. It does not protect you from a malicious
program running as the same user: that program can delete <code>~/.mcp-pin</code> and
re-pin itself. That is an architectural limit, not a bug. Day-one malice that never
changes is also invisible. Do not read a pin, or a badge, as a safety rating.</p>

<h2 style="margin-top:52px">How the crawler behaves</h2>
<p class="body">These are commitments, not aspirations. If the crawler ever violates one,
that is a bug and I want to hear about it.</p>
<ul class="body">
<li>It identifies itself as <code>mcp-pin-crawler</code> with a link to the source repository.</li>
<li>It calls <code>initialize</code> and <code>tools/list</code>. <strong>It never invokes a tool</strong>,
never sends arguments, and never causes a side effect on anyone's system.</li>
<li>It runs at most once per server per day. This is a daily record, not real-time monitoring: a change can sit unrecorded for up to 24 hours.</li>
<li>It never supplies a real credential and never attempts to bypass authentication.
When a server exits because an environment variable is unset, the crawler reads the variable
name the server itself printed and retries once with the obvious placeholder
<code>mcp-pin-probe-placeholder</code>. Any server that validates that value rejects it. If a server
still refuses, it is recorded as unindexable and left alone.</li>
<li>A server that errors is not retried until the next day.</li>
<li>Probing runs on disposable cloud infrastructure, never on a personal machine, and holds
no credentials.</li>
</ul>

<h2 style="margin-top:52px">Opting out</h2>
<p class="body">If you maintain a server here and do not want it crawled, say so and it stops.
Add it to <a href="${REPO}/blob/main/OPTOUT.txt">OPTOUT.txt</a>, open an issue titled
<code>opt out: your-server-name</code>, or email me. <strong>No justification is requested and
none is required.</strong> You will not be asked to explain yourself and I will not try to
talk you out of it.</p>
<p class="body">It takes effect on the next crawl and the pages come down. One thing stated
honestly rather than glossed over: the log is append-only by design, so entries already
written stay in the file. If you need existing entries removed as well, ask, and I will
publish a signed note explaining what was removed and why, because silently editing a
transparency log would defeat its entire purpose.</p>

<h2 style="margin-top:52px">Corrections</h2>
<p class="body">If anything here is wrong about your server, tell me and I will fix it and
say what changed. Accuracy matters more to this project than completeness.</p>

<h2 style="margin-top:52px">No warranty</h2>
<p class="body">This is provided as is, without warranty of any kind, under the
<a href="${REPO}/blob/main/LICENSE">MIT licence</a>. It is a hobby research project run by one
person alongside university study. Do not treat it as a commercial service, and do not build a
compliance process on it. The log and the badges are meant to keep running; if that ever changes,
this page will say so before anything is switched off.
The <a href="${REPO}/blob/main/docs/THREAT_MODEL.md">threat model</a> is explicit about what
the tool does not defend against.</p>

<h2 style="margin-top:52px">Contact</h2>
<p class="body">Security issues: see <a href="${REPO}/blob/main/SECURITY.md">SECURITY.md</a> and
use GitHub's private reporting rather than a public issue.
Everything else: <a href="${REPO}/issues">open an issue</a>.
For anything you would rather not discuss in public, my contact details are on my
<a href="https://github.com/GautamTalksDev">GitHub profile</a>.</p>
</section></div></main>`,
    { desc: 'Who runs mcp-pin, how the crawler behaves, and how to opt out.', path: '/about.html' }));

  // ------------------------------------------------------------- reports
  // Monthly drift reports from data/reports, written by crawler/drift-report.js.
  // Counts per server only: the labels are totals, never shown against a name.
  const REPORT_LABELS = [
    ['new-tool', 'added a tool'],
    ['removed', 'removed a tool'],
    ['new-field', 'added an input field'],
    ['field-removed', 'removed an input field'],
    ['field-type', 'changed the type of an input field'],
    ['output-schema', 'changed an output schema'],
    ['hints', 'changed a permission hint (readOnlyHint and the like, which clients use to auto-approve)'],
    ['instruction', 'added wording that tells the model what to do'],
    ['secrets', 'added mentions of secrets or private files'],
    ['link', 'added a link or address'],
    ['hidden', 'added hidden or unusual characters'],
    ['wording', 'changed wording only'],
  ];
  const monthName = (m) => `${MONTHS_LONG[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
  const reports = (() => {
    try { return fs.readdirSync(path.join(DATA, 'reports')).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort().reverse(); } catch { return []; }
  })().map((f) => JSON.parse(fs.readFileSync(path.join(DATA, 'reports', f), 'utf8')));
  if (reports.length) {
    fs.mkdirSync(path.join(OUT, 'reports'), { recursive: true });
    for (const r of reports) {
      const ch = r.changes;
      const title = `MCP drift report, ${monthName(r.month)}`;
      const rows = r.servers.filter((s) => safeId(s.id)).map((s) => {
        const bits = [];
        if (s.tools_added) bits.push(`${s.tools_added} added`);
        if (s.tools_removed) bits.push(`${s.tools_removed} removed`);
        if (s.tools_changed) bits.push(`${s.tools_changed} changed` + (s.schema_only ? `, ${s.schema_only} of them in the schema only` : ''));
        const when = s.changes > 1
          ? `changed ${s.changes} times, first seen ${longDate(s.first_seen_changed)}, last ${longDate(s.last_seen_changed)}`
          : s.last_look_before
            ? `changed between ${longDate(s.last_look_before)} and ${longDate(s.first_seen_changed)}`
            : `first seen changed ${longDate(s.first_seen_changed)}`;
        return `<div class="row"><div><div class="nm"><a href="/servers/${s.id}.html">${esc(s.name)}</a></div>
<div class="meta">${esc(when)}</div></div>
<div class="right"><div class="meta">tools: ${esc(bits.join('; ') || 'definitions changed')}</div></div></div>`;
      }).join('\n');
      const labels = REPORT_LABELS.filter(([k]) => ch.labels[k])
        .map(([k, text]) => `<div class="row"><div class="nm">${esc(text)}</div><div class="right"><b>${ch.labels[k]}</b></div></div>`).join('\n');
      const gaps = r.coverage.gaps.map((g) => `<p class="body">No crawl ran from ${esc(longDate(g.from))} to ${esc(longDate(g.to))}: ${esc(g.note)}. A change first seen after that gap happened at some point inside it.</p>`).join('\n');
      fs.writeFileSync(path.join(OUT, 'reports', r.month + '.json'), JSON.stringify(r, null, 2));
      fs.writeFileSync(path.join(OUT, 'reports', r.month + '.html'), page(title, `
<main id="main"><div class="page-head"><div class="wrap">
  <p class="eyebrow"><a href="/reports/">Drift reports</a></p>
  <h1 class="display">${esc(monthName(r.month))}</h1>
  <p class="lede">${r.partial ? '<strong>Month in progress.</strong> ' : ''}What changed in the definitions of the MCP servers this log tracks,
  counted from the signed public log on ${esc(longDate(r.generated_at))}. Every number here can be checked:
  <a href="/reports/${r.month}.json">the report as JSON</a>, and the log it was counted from.</p>
</div></div>
<div class="wrap"><div class="facts">
  <div class="fact"><b>${ch.servers}</b><span>servers changed their tool definitions</span></div>
  <div class="fact"><b>${r.coverage.tracked}</b><span>servers tracked by the end of the month</span></div>
  <div class="fact"><b>${ch.tools.schemaOnly}</b><span>tools changed in the schema only, with the description untouched</span></div>
  <div class="fact"><b>${r.coverage.recorded_new}</b><span>servers recorded for the first time</span></div>
</div>
<section class="doc">
  <h2>Coverage</h2>
  ${gaps || '<p class="body">The crawl ran without a recorded gap this month.</p>'}
  ${ch.days_between_looks ? `<p class="body">Between the last look before a change and the first look that saw it: ${ch.days_between_looks.median} days at the median, ${ch.days_between_looks.max} at most.</p>` : ''}
  <h2>What kinds of change</h2>
  <p class="body">Servers with at least one change of each kind. A server can count under several. The labels are mechanical: each means the new definitions match a pattern the old ones did not, not that anyone did anything wrong, so they are totals and are never shown against a named server.</p>
  ${labels || '<p class="body">No changes.</p>'}
  <h2>Servers that changed</h2>
  <p class="body">Each links to that server&rsquo;s full history, with every diff. Tool counts only.</p>
  ${rows || '<p class="body">None.</p>'}
  <h2>How this was counted</h2>
  ${r.notes.map((n) => `<p class="body">${esc(n)}</p>`).join('\n')}
</section></div></main>`, { desc: `${ch.servers} MCP servers changed their tool definitions in ${monthName(r.month)}. Counted from a signed public log.`, path: `/reports/${r.month}.html` }));
    }
    fs.writeFileSync(path.join(OUT, 'reports', 'index.html'), page('MCP drift reports', `
<main id="main">
${head('Drift reports', 'What changed,<br><em>month by month.</em>', 'How many MCP servers changed what their tools tell the model, and what kind of change it was, counted from the signed public log.')}
<div class="wrap"><section class="doc">
${reports.map((r) => `<div class="row"><div class="nm"><a href="/reports/${r.month}.html">${esc(monthName(r.month))}${r.partial ? ' (in progress)' : ''}</a></div><div class="right"><div class="meta">${r.changes.servers} of ${r.coverage.tracked} servers changed</div></div></div>`).join('\n')}
</section></div></main>`, { desc: 'Monthly reports on how MCP tool definitions change, from a signed public log.', path: '/reports/' }));
  }

  // ------------------------------------------------- robots, sitemap, 404
  // The header CSP allows exactly the inline scripts above, by hash, and no
  // other inline script anywhere. Browsers hash the text with LF line endings.
  const hashes = [...new Set(inlineScripts.map((s) =>
    `'sha256-${crypto.createHash('sha256').update(s.replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}'`))];
  const headers = fs.readFileSync(path.join(__dirname, '_headers'), 'utf8');
  if (!headers.includes('__INLINE_SCRIPT_HASHES__')) throw new Error('site/_headers: the CSP lost its __INLINE_SCRIPT_HASHES__ placeholder');
  fs.writeFileSync(path.join(OUT, '_headers'), headers.split('__INLINE_SCRIPT_HASHES__').join(hashes.join(' ')));
  fs.copyFileSync(path.join(__dirname, '_redirects'), path.join(OUT, '_redirects'));
  fs.writeFileSync(path.join(OUT, 'robots.txt'),
    `User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`);

  const urls = ['/', '/log/', '/install/', '/spot/', '/about.html']
    .concat(reports.length ? ['/reports/'].concat(reports.map((r) => `/reports/${r.month}.html`)) : [])
    .concat(servers.map((s) => `/servers/${s.id}.html`));
  fs.writeFileSync(path.join(OUT, 'sitemap.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => `  <url><loc>${SITE}${u}</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod></url>`).join('\n') +
    '\n</urlset>\n');

  fs.writeFileSync(path.join(OUT, '404.html'), page('Not found', `
<main id="main">
${head('404', 'That page is <em>not here.</em>', 'If you were looking for a server, it may not have been crawled yet, or its maintainer may have asked to be removed. Both happen.')}
<div class="wrap" style="padding:40px 0 120px"><a class="btn btn-primary" href="/log/">Search the public log <span class="arrow">→</span></a></div>
</main>`, { desc: 'Page not found.', path: '/404.html' }));

  fs.writeFileSync(path.join(OUT, 'api', 'servers.json'), JSON.stringify(servers, null, 2));
  process.stderr.write(`built ${servers.length} server pages into ${OUT}\n`);
})();
