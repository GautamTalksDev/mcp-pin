#!/usr/bin/env node
'use strict';
/*
 * Draft the 20 outreach messages from what the log actually observed.
 *
 *   node crawler/outreach.js > DRAFTS.md
 *
 * Every message carries one true, specific observation about that person's
 * own server. That is the whole hook: you are showing them a record of their
 * project they have never seen. A generic message is worse than no message.
 *
 * This writes drafts. It does not send anything. Read every one, add the
 * author's name, and cut anything that reads like a template.
 */
const fs = require('fs');
const path = require('path');
const { PublicLog } = require('./log');
const { days } = require('./badge');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const DATA = path.resolve(flag('--data', 'data'));
const SITE = process.env.SITE_URL || 'https://mcp-pin.gautamkhosla.com';
const VIDEO = process.env.VIDEO_URL || '<paste the video link>';

const log = new PublicLog(DATA);
const state = JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'));
const servers = Object.values(state.servers)
  .filter((s) => s.set_hash)
  .sort((a, b) => (b.downloads || 0) - (a.downloads || 0));

// The observation has to be true and specific to them, or the message is spam.
function observe(s) {
  const hist = log.history(s.id);
  if (hist.length > 1) {
    const last = hist[hist.length - 1];
    const prev = hist[hist.length - 2];
    const prevNames = new Map(prev.tools.map((t) => [t.name, t]));
    const changed = last.tools.filter((t) => {
      const o = prevNames.get(t.name);
      return o && o.hash !== t.hash;
    }).map((t) => t.name);
    const added = last.tools.filter((t) => !prevNames.has(t.name)).map((t) => t.name);
    const date = last.observed_at.slice(0, 10);
    if (changed.length) return `the description of \`${changed[0]}\` changed on ${date}`;
    if (added.length) return `\`${added[0]}\` appeared on ${date}`;
    return `the tool set changed on ${date}`;
  }
  const t = days(s.first_seen_at);
  const names = (hist[0] ? hist[0].tools : []).map((x) => x.name);
  if (t >= 1) return `all ${s.tool_count} tools unchanged for the ${t} day${t === 1 ? '' : 's'} it has been tracked`;
  return `all ${s.tool_count} tools fingerprinted, including \`${names[0]}\` and \`${names[1] || names[0]}\``;
}

let out = `# Outreach drafts

Generated ${new Date().toISOString().slice(0, 10)}. ${servers.length} servers.

Rules before sending any of these:
1. Find the author's actual name and their preferred channel (GitHub issue, email, X).
2. Read their README first. If the message could have been sent to anyone, rewrite it.
3. One observation, one link, one optional ask, an explicit invitation to say it is useless.
4. Log the send in OUTREACH.md **before** writing another line of code.

---

`;

servers.forEach((s, i) => {
  const url = `${SITE}/servers/${s.id}.html`;
  const badge = `[![mcp-pin](${SITE}/badge/${s.id}.svg)](${url})`;
  out += `## ${i + 1}. ${s.name}${s.downloads ? `  (${s.downloads.toLocaleString()} downloads/month)` : ''}

${s.homepage ? `Repo: ${s.homepage}\n` : ''}Page: ${url}

> Subject: your \`${s.name}\` MCP server, its tool definitions over time
>
> Hi <name>,
>
> I have been crawling public MCP servers and keeping a history of their tool
> descriptions, because clients prompt for approval once and then never re-check.
> Here is the page for yours: ${url}
>
> Right now: ${observe(s)}.
>
> If it is useful, this badge shows your users the definitions are being watched:
>
> \`${badge}\`
>
> And here is the 40 second demo that made me build it: ${VIDEO}
>
> No ask beyond that. If it is useless, tell me why. That is the most helpful reply.
>
> Gautam

`;
});

process.stdout.write(out);
process.stderr.write(`${servers.length} drafts written. Do not send any unedited.\n`);
