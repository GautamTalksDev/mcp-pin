'use strict';
/*
 * Shared security controls.
 *
 * Everything the crawler touches is attacker controlled. A tool description
 * is written by whoever runs the server, and we fetch, parse, store and
 * render it. These limits exist so that a hostile server can waste our time
 * but cannot take the crawler down, poison the log, or reach anything on the
 * private network.
 */
const dns = require('dns').promises;
const net = require('net');

const LIMITS = Object.freeze({
  MAX_TOOLS_PER_SERVER: 2000,
  MAX_TOOL_BYTES: 256 * 1024,
  MAX_TOOLSET_BYTES: 8 * 1024 * 1024,
  MAX_HTTP_BYTES: 8 * 1024 * 1024,
  MAX_REDIRECTS: 3,
  HTTP_TIMEOUT_MS: 20000,
  STDIO_TIMEOUT_MS: 30000,
  INSTALL_TIMEOUT_MS: 180000,
  MAX_NAME_LEN: 512,
});

// RFC1918, loopback, link local, CGNAT, multicast, and the cloud metadata
// address. A server that resolves here is trying to make the crawler its
// proxy into a private network (SSRF).
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true; // includes 169.254.169.254
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    if (p[0] >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const a = ip.toLowerCase();
    if (a === '::1' || a === '::') return true;
    if (a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd')) return true;
    if (a.startsWith('::ffff:')) return isPrivateAddress(a.slice(7));
    return false;
  }
  return true;
}

// Validate before every request, including after each redirect.
async function assertSafeUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('malformed url'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme not allowed: ' + u.protocol);
  if (u.username || u.password) throw new Error('credentials in url are not allowed');
  if (process.env.MCP_PIN_ALLOW_PRIVATE === '1') return u;

  let addrs;
  try { addrs = await dns.lookup(u.hostname, { all: true }); } catch { throw new Error('dns resolution failed'); }
  if (!addrs.length) throw new Error('dns returned no records');
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new Error('refusing to probe private address ' + a.address);
  }
  return u;
}

// fetch with manual redirect handling, per hop revalidation, a byte cap, and
// a hard timeout. Never follows a redirect into private space.
async function safeFetch(url, init = {}, opts = {}) {
  const maxBytes = opts.maxBytes || LIMITS.MAX_HTTP_BYTES;
  const timeoutMs = opts.timeoutMs || LIMITS.HTTP_TIMEOUT_MS;
  let current = url;

  for (let hop = 0; hop <= LIMITS.MAX_REDIRECTS; hop++) {
    await assertSafeUrl(current);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(current, Object.assign({}, init, { redirect: 'manual', signal: ac.signal }));
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }

    const declared = parseInt(res.headers.get('content-length') || '0', 10);
    if (declared && declared > maxBytes) throw new Error('response too large');

    // Stream so a server cannot send an unbounded body.
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) return { res, text: await res.text() };
    let received = 0;
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > maxBytes) { try { reader.cancel(); } catch {} throw new Error('response exceeded byte cap'); }
      chunks.push(value);
    }
    return { res, text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8') };
  }
  throw new Error('too many redirects');
}

// A hostile server can return thousands of enormous tools. Reject rather
// than truncate: a partial record would be a false fingerprint, and a false
// fingerprint in a transparency log is worse than no record.
function validateToolset(tools) {
  if (!Array.isArray(tools)) return { ok: false, error: 'tools is not an array' };
  if (tools.length > LIMITS.MAX_TOOLS_PER_SERVER) return { ok: false, error: `too many tools (${tools.length})` };
  let total = 0;
  for (const t of tools) {
    if (!t || typeof t !== 'object') return { ok: false, error: 'tool is not an object' };
    if (typeof t.name !== 'string' || !t.name.length) return { ok: false, error: 'tool has no name' };
    if (t.name.length > LIMITS.MAX_NAME_LEN) return { ok: false, error: 'tool name too long' };
    let size;
    try { size = Buffer.byteLength(JSON.stringify(t), 'utf8'); } catch { return { ok: false, error: 'tool is not serializable' }; }
    if (size > LIMITS.MAX_TOOL_BYTES) return { ok: false, error: `tool ${t.name} too large` };
    total += size;
    if (total > LIMITS.MAX_TOOLSET_BYTES) return { ok: false, error: 'toolset too large' };
  }
  return { ok: true };
}

// Never let a server-controlled string reach the filesystem. Ids are
// derived hashes; this is belt and braces against a future code path that
// forgets that.
function safeId(id) {
  return /^[a-f0-9]{8,64}$/.test(String(id)) ? String(id) : null;
}

module.exports = { LIMITS, isPrivateAddress, assertSafeUrl, safeFetch, validateToolset, safeId };
