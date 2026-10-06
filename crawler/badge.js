'use strict';
/*
 * Badge. Pure function so it runs identically in the static build and in a
 * Cloudflare Worker.
 */
const COLORS = { green: '#3fb950', amber: '#d29922', red: '#f85149', grey: '#8b949e' };

// Text and attribute values alike: the label and message also sit in aria-label.
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function width(text) {
  // Verdana 11px average advance; good enough and deterministic.
  return Math.ceil(text.length * 6.2) + 12;
}

function badge(label, message, color) {
  const lw = width(label), mw = width(message), total = lw + mw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${esc(label)}: ${esc(message)}">
<title>${esc(label)}: ${esc(message)}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)">
<rect width="${lw}" height="20" fill="#24292f"/>
<rect x="${lw}" width="${mw}" height="20" fill="${color}"/>
<rect width="${total}" height="20" fill="url(#s)"/>
</g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(label)}</text>
<text x="${lw / 2}" y="14">${esc(label)}</text>
<text x="${lw + mw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(message)}</text>
<text x="${lw + mw / 2}" y="14">${esc(message)}</text>
</g></svg>`;
}

function days(fromISO) {
  return Math.floor((Date.now() - new Date(fromISO).getTime()) / 86400000);
}

const DAY = 86400000;
// Past this many days without a good probe, the record is stale and says so.
const STALE_DAYS = 3;
// A change seen after a gap wider than this cannot be dated to one day.
const WIDE_WINDOW_DAYS = 2;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(iso) {
  const d = new Date(iso);
  return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
}

// The last time the crawler actually saw this server's tools. State written
// before last_ok_at existed falls back to the last probe unless it failed, and
// then to when the current set_hash was first recorded: an earlier date than
// the real last look, never a later one.
function lastSeen(server) {
  return server.last_ok_at || (!server.last_error && server.last_probe_at) ||
    server.last_change_at || server.first_seen_at || null;
}

function between(fromISO, toISO) {
  return Math.floor((new Date(toISO).getTime() - new Date(fromISO).getTime()) / DAY);
}

// One status for the badge and the site. The states are deliberately factual:
// every one is about time, and none of them says "safe".
function status(server) {
  if (!server || !server.set_hash) return { text: 'unknown', color: 'grey' };
  const seen = lastSeen(server);
  // Counting days nobody observed would state something nobody saw. Stop
  // counting at the last good look, and past a few days say when that was.
  if (!seen) return { text: 'not checked', color: 'grey' };
  if (days(seen) > STALE_DAYS) return { text: 'last checked ' + shortDate(seen), color: 'grey' };
  if (!server.last_change_at) {
    const t = between(server.first_seen_at, seen);
    return { text: t < 1 ? 'tracking started' : `unchanged ${t}d`, color: 'green' };
  }
  const d = days(server.last_change_at);
  const after = server.last_change_after;
  const wide = after && between(after, server.last_change_at) > WIDE_WINDOW_DAYS;
  if (d <= 7 && wide) return { text: 'changed since ' + shortDate(after), color: d < 1 ? 'red' : 'amber' };
  if (d < 1) return { text: 'changed today', color: 'red' };
  if (d <= 7) return { text: `changed ${d}d ago`, color: 'amber' };
  return { text: `unchanged ${between(server.last_change_at, seen)}d`, color: 'green' };
}

function badgeFor(server) {
  const s = status(server);
  return badge('mcp-pin', s.text, COLORS[s.color]);
}

module.exports = { badge, badgeFor, status, lastSeen, shortDate, days, between, COLORS, STALE_DAYS, WIDE_WINDOW_DAYS };
