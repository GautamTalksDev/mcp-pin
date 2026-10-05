'use strict';

const C = {
  red: (s) => (process.stderr.isTTY ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s) => (process.stderr.isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  bold: (s) => (process.stderr.isTTY ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s),
};

function pretty(canonical) {
  return JSON.stringify(JSON.parse(canonical), null, 2).split('\n');
}

// Plain LCS diff. No dependency, deterministic, good enough for tool objects.
function lcsDiff(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([' ', a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(['-', a[i]]); i++; }
    else { out.push(['+', b[j]]); j++; }
  }
  while (i < n) out.push(['-', a[i++]]);
  while (j < m) out.push(['+', b[j++]]);
  return out;
}

function renderToolDiff(name, oldCanonical, newCanonical) {
  const rows = lcsDiff(pretty(oldCanonical), pretty(newCanonical));
  const lines = [`--- pinned/${name}`, `+++ observed/${name}`];
  // Collapse long runs of context.
  let ctx = 0;
  for (const [mark, text] of rows) {
    if (mark === ' ') {
      ctx++;
      if (ctx > 3) continue;
      lines.push(C.dim('  ' + text));
    } else {
      ctx = 0;
      lines.push(mark === '-' ? C.red('- ' + text) : C.green('+ ' + text));
    }
  }
  return lines.join('\n');
}

// The server's own instructions to the model, diffed line by line.
function renderTextDiff(name, oldText, newText) {
  const lines = [`--- pinned/${name}`, `+++ observed/${name}`];
  const a = oldText == null ? ['(none)'] : String(oldText).split('\n');
  const b = newText == null ? ['(none)'] : String(newText).split('\n');
  for (const [mark, text] of lcsDiff(a, b)) {
    if (mark === ' ') lines.push(C.dim('  ' + text));
    else lines.push(mark === '-' ? C.red('- ' + text) : C.green('+ ' + text));
  }
  return lines.join('\n');
}

function renderDrift(driftList) {
  const out = [];
  for (const d of driftList) {
    const noun = d.what === 'prompt' ? 'prompt' : 'tool';
    if (d.kind === 'added') out.push(C.green(`+ ${noun} added: ${d.name}`));
    else if (d.kind === 'removed') out.push(C.red(`- ${noun} removed: ${d.name}`));
    else if (d.kind === 'instructions') out.push(renderTextDiff('server-instructions', d.oldText, d.newText));
    else out.push(renderToolDiff(noun === 'prompt' ? 'prompt:' + d.name : d.name, d.oldCanonical, d.newCanonical));
  }
  return out.join('\n\n');
}

// The triage line per changed item, most serious first, before the full diff.
function renderSummary(driftList) {
  const { summarize } = require('./classify');
  const rows = summarize(driftList);
  const width = Math.min(28, Math.max(...rows.map((r) => r.name.length)));
  const out = [C.bold('  What changed')];
  for (const r of rows) {
    const text = r.labels.map((l) => l.label).join('; ');
    const line = `    ${r.name.padEnd(width)}  ${text}`;
    out.push(r.level === 'high' ? C.red(line) : r.level === 'low' ? C.dim(line) : line);
  }
  return out.join('\n');
}

module.exports = { renderDrift, renderToolDiff, renderTextDiff, renderSummary, C };
