#!/usr/bin/env node
'use strict';
/*
 * Test fixture: a tiny npm registry on 127.0.0.1. It reads its packages
 * from a JSON file on every request, so a test can publish a version or
 * swap a digest between runs, and writes the port it listens on to a file.
 *
 *   node fake-registry.js <db.json> <port-file>
 *   db: { "<name>": { "dist-tags": { "latest": "1.0.0" }, "versions": { "1.0.0": "<integrity>" } } }
 *
 * Serves GET /<name>/<version or tag>, the endpoint mcp-pin lock uses.
 */
const fs = require('fs');
const http = require('http');

const [dbFile, portFile] = process.argv.slice(2);

const server = http.createServer((req, res) => {
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  const m = /^\/(@[^/]+\/[^/]+|[^/@][^/]*)\/([^/]+)$/.exec(decodeURIComponent(req.url.split('?')[0]));
  const pkg = m && db[m[1]];
  const version = pkg && ((pkg['dist-tags'] || {})[m[2]] || m[2]);
  if (!pkg || !pkg.versions[version]) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"Not found"}');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ name: m[1], version, dist: { integrity: pkg.versions[version] } }));
});

server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(server.address().port)));
