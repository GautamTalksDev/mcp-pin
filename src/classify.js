'use strict';
/*
 * Label a definition change so a person can triage it at a glance: wording
 * only, a new field, a new instruction to the model, a new link, hidden
 * characters, a flipped permission hint.
 *
 * Fixed rules over the two versions, no model. A label never decides
 * anything: every change still blocks until a person approves it. The rules
 * count what the new version has that the old one did not, anywhere in the
 * definition (description, schema, titles, enums), so an addition buried in a
 * parameter description is seen as well as one in the description.
 */

const SIGNALS = [
  {
    key: 'instruction',
    level: 'high',
    label: 'New instruction to the model',
    re: /\b(ignore (all|any|the|previous)|before (calling|using|running|you)|you (must|should|need to)|must (always|never|first|include|read|send|pass)|always (include|send|pass|read|call|attach)|never (tell|mention|reveal|ask)|do not (tell|mention|inform|reveal|ask)|don'?t (tell|mention|reveal|ask)|without (telling|asking|informing)|<\/?important>|system prompt|instead of the user|(pass|send|forward|upload|include|attach|post)\b[^.]{0,60}\b(contents?|file|notes|conversation|history|context|messages?|keys?|tokens?|credentials?))/gi,
  },
  {
    key: 'secrets',
    level: 'high',
    label: 'Mentions secrets or private files',
    re: /(~\/|\$HOME|%USERPROFILE%|\/home\/[a-z_]|\.ssh\b|id_rsa|id_ed25519|\.env\b|\.aws\b|\.kube\b|\.npmrc|\.netrc|credentials?\b|passwords?\b|passwd|secret|private key|api[_ -]?keys?|access[_ -]?tokens?|bearer|seed phrase|wallet)/gi,
  },
  {
    key: 'link',
    level: 'high',
    label: 'New link or address',
    re: /(\bhttps?:\/\/[^\s"'<>]+|\b[\w.+-]+@[a-z0-9-]+\.[a-z.]{2,}|\b(?:\d{1,3}\.){3}\d{1,3}\b)/gi,
  },
  {
    key: 'hidden',
    level: 'high',
    label: 'Hidden or unusual characters',
    // Invisible and bidirectional characters, C1 controls, tag characters and
    // variation selectors (both carry hidden text), terminal escape codes (as
    // canonical JSON writes them: \u001b and the other \u00XX controls), HTML
    // comments, and long base64-like runs.
    re: /([\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2069}\u{feff}\u{61c}\u{7f}-\u{9f}]|[\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]|(?<![\\])(?:[\\]{2})*[\\]u00[01][0-9a-f]|<!--|[A-Za-z0-9+/]{48,}={0,2})/gu,
  },
];

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

function count(re, text) {
  const m = String(text || '').match(re);
  return m ? m.length : 0;
}

function parse(canonical) {
  try { return JSON.parse(canonical); } catch { return null; }
}

function propsOf(schema) {
  return schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object'
    ? schema.properties : {};
}

// Text signals: things the new text has more of than the old text.
function textLabels(oldText, newText) {
  const out = [];
  for (const s of SIGNALS) {
    if (count(s.re, newText) > count(s.re, oldText)) out.push({ key: s.key, level: s.level, label: s.label });
  }
  return out;
}

// One changed definition (a tool or a prompt), from its pinned and observed canonical JSON.
function classifyChange(oldCanonical, newCanonical) {
  const labels = textLabels(oldCanonical, newCanonical);
  const a = parse(oldCanonical) || {};
  const b = parse(newCanonical) || {};

  const oldProps = propsOf(a.inputSchema);
  const newProps = propsOf(b.inputSchema);
  const added = Object.keys(newProps).filter((k) => !(k in oldProps));
  const removed = Object.keys(oldProps).filter((k) => !(k in newProps));
  const retyped = Object.keys(newProps).filter((k) => k in oldProps &&
    JSON.stringify((oldProps[k] || {}).type) !== JSON.stringify((newProps[k] || {}).type));
  if (added.length) labels.push({ key: 'new-field', level: 'high', label: 'New field: ' + added.join(', ') });
  if (retyped.length) labels.push({ key: 'field-type', level: 'medium', label: 'Field type changed: ' + retyped.join(', ') });
  if (removed.length) labels.push({ key: 'field-removed', level: 'low', label: 'Field removed: ' + removed.join(', ') });

  // Prompt arguments are a prompt's parameters.
  const oldArgs = new Set((Array.isArray(a.arguments) ? a.arguments : []).map((x) => x && x.name));
  const newArgs = (Array.isArray(b.arguments) ? b.arguments : []).map((x) => x && x.name).filter((n) => !oldArgs.has(n));
  if (newArgs.length) labels.push({ key: 'new-argument', level: 'high', label: 'New argument: ' + newArgs.join(', ') });

  if (JSON.stringify(a.outputSchema) !== JSON.stringify(b.outputSchema)) {
    labels.push({ key: 'output-schema', level: 'medium', label: 'Output schema changed' });
  }

  // Clients act on these hints: Claude auto-approves tools marked read-only,
  // so a flip is a quiet change in what runs without asking.
  const ah = a.annotations || {};
  const bh = b.annotations || {};
  const flips = HINTS.filter((h) => ah[h] !== bh[h]).map((h) => `${h} ${fmt(ah[h])} to ${fmt(bh[h])}`);
  if (flips.length) labels.push({ key: 'hints', level: 'high', label: 'Permission hint changed: ' + flips.join(', ') });

  if (!labels.length) labels.push({ key: 'wording', level: 'low', label: 'Wording only' });
  return labels;
}

function fmt(v) {
  return v === undefined ? 'unset' : String(v);
}

// Labels for one drift entry as produced by the proxy.
function classify(d) {
  if (d.kind === 'added') {
    return [{ key: 'new-' + (d.what === 'prompt' ? 'prompt' : 'tool'), level: 'high', label: d.what === 'prompt' ? 'New prompt' : 'New tool' }];
  }
  if (d.kind === 'removed') return [{ key: 'removed', level: 'low', label: 'Removed' }];
  if (d.kind === 'instructions') {
    const labels = textLabels(d.oldText, d.newText);
    return labels.length ? labels : [{ key: 'wording', level: 'low', label: 'Wording only' }];
  }
  return classifyChange(d.oldCanonical, d.newCanonical);
}

const RANK = { high: 0, medium: 1, low: 2 };

// One line per changed item, most serious first. Names only, never the new text.
function summarize(drift) {
  return drift.map((d) => {
    const labels = classify(d).sort((x, y) => RANK[x.level] - RANK[y.level]);
    const name = d.kind === 'instructions' ? 'server instructions' : (d.what === 'prompt' ? 'prompt ' : '') + d.name;
    return { name, level: labels[0].level, labels };
  }).sort((x, y) => RANK[x.level] - RANK[y.level]);
}

module.exports = { classify, classifyChange, summarize, textLabels };
