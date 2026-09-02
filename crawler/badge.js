'use strict';
/*
 * Badge. Pure function so it runs identically in the static build and in a
 * Cloudflare Worker.
 */
const COLORS = { green: '#3fb950', amber: '#d29922', red: '#f85149', grey: '#8b949e' };

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

// The badge states are deliberately factual. It never says "safe".
function badgeFor(server) {
  if (!server || !server.set_hash) return badge('mcp-pin', 'unknown', COLORS.grey);
  if (!server.last_change_at) {
    const t = days(server.first_seen_at);
    return badge('mcp-pin', t < 1 ? 'tracking started' : `unchanged ${t}d`, COLORS.green);
  }
  const d = days(server.last_change_at);
  if (d < 1) return badge('mcp-pin', 'changed today', COLORS.red);
  if (d <= 7) return badge('mcp-pin', `changed ${d}d ago`, COLORS.amber);
  return badge('mcp-pin', `unchanged ${d}d`, COLORS.green);
}

module.exports = { badge, badgeFor, days, COLORS };
