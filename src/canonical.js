'use strict';
const crypto = require('crypto');

// RFC 8785 (JCS) subset sufficient for MCP tool metadata:
// - object keys sorted by UTF-16 code unit
// - no insignificant whitespace
// - JS number serialization (ECMA-262), which matches JCS for all
//   values that appear in JSON Schema (integers, small decimals)
function canonicalize(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number in tool metadata');
    return JSON.stringify(value);
  }
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort(compareCodeUnits);
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  throw new Error('unserializable value of type ' + t);
}

function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// The full metadata surface. Anything the model can read is in scope,
// because anything the model can read can redirect it.
function fingerprintTool(tool) {
  const canon = canonicalize(tool);
  return { name: tool && tool.name, hash: sha256(canon), canonical: canon };
}

// Fingerprint of the whole tools/list result: catches added and removed
// tools, not just mutated ones.
function fingerprintToolset(tools) {
  const per = (tools || []).map(fingerprintTool).sort((a, b) => compareCodeUnits(a.name, b.name));
  const setHash = sha256(per.map((t) => t.name + ':' + t.hash).join('\n'));
  return { setHash, tools: per };
}

// True when any object in this JSON text repeats a member name. JSON.parse
// keeps the last copy and some parsers keep the first, so a client could
// read a value the check never saw. The text must already parse.
function repeatsMemberName(text) {
  const stack = []; // per open object: { names, expectName }; null for an array
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && top.expectName) {
        const name = JSON.parse(text.slice(i, j + 1));
        if (top.names.has(name)) return true;
        top.names.add(name);
        top.expectName = false;
      }
      i = j;
    } else if (c === '{') stack.push({ names: new Set(), expectName: true });
    else if (c === '[') stack.push(null);
    else if (c === '}' || c === ']') stack.pop();
    else if (c === ',' && stack[stack.length - 1]) stack[stack.length - 1].expectName = true;
  }
  return false;
}

module.exports = { canonicalize, sha256, fingerprintTool, fingerprintToolset, repeatsMemberName };
