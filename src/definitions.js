'use strict';
/*
 * What the model reads from a server, observed and compared in one place.
 * Shared by the proxy, mcp-pin review and mcp-pin lookup.
 */
const { fingerprintToolset, sha256 } = require('./canonical');

// Everything the model reads from a server, observed in one place.
function observe(tools, prompts, instructions) {
  const fp = fingerprintToolset(tools);
  const out = { setHash: fp.setHash, tools: fp.tools };
  if (prompts) {
    const pp = fingerprintToolset(prompts);
    out.promptsHash = pp.setHash;
    out.prompts = pp.tools;
  }
  out.instructions = instructions;
  out.instructionsHash = instructions === null ? null : sha256(instructions);
  return out;
}

function diffNamed(pinned, observed, what) {
  const oldBy = new Map((pinned || []).map((t) => [t.name, t]));
  const newBy = new Map((observed || []).map((t) => [t.name, t]));
  const out = [];
  for (const [name, t] of newBy) {
    const o = oldBy.get(name);
    if (!o) out.push({ kind: 'added', what, name });
    else if (o.hash !== t.hash) out.push({ kind: 'changed', what, name, oldCanonical: o.canonical, newCanonical: t.canonical });
  }
  for (const name of oldBy.keys()) if (!newBy.has(name)) out.push({ kind: 'removed', what, name });
  return out;
}

// Pins made by 0.1.4 and earlier cover tools only; their prompts and
// instructions fields are undefined and are recorded on the next clean connect.
function diffDefinitions(pin, obs) {
  const drift = [];
  if (pin.setHash !== obs.setHash) drift.push(...diffNamed(pin.tools, obs.tools, 'tool'));
  if (pin.prompts !== undefined && obs.prompts !== undefined && pin.promptsHash !== obs.promptsHash) {
    drift.push(...diffNamed(pin.prompts, obs.prompts, 'prompt'));
  }
  if (pin.instructionsHash !== undefined && pin.instructionsHash !== obs.instructionsHash) {
    drift.push({ kind: 'instructions', oldText: pin.instructions, newText: obs.instructions });
  }
  return drift;
}

function definitionFields(src) {
  const out = {};
  for (const k of ['promptsHash', 'prompts', 'instructionsHash', 'instructions']) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

function logDefinitions(obs) {
  return {
    set_hash: obs.setHash,
    tools: obs.tools.map((t) => ({ name: t.name, hash: t.hash, canonical_json: t.canonical })),
    prompts: obs.prompts ? obs.prompts.map((t) => ({ name: t.name, hash: t.hash, canonical_json: t.canonical })) : undefined,
    instructions_hash: obs.instructionsHash,
  };
}

module.exports = { observe, diffNamed, diffDefinitions, definitionFields, logDefinitions };
