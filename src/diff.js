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

function renderDrift(driftList) {
  const out = [];
  for (const d of driftList) {
    if (d.kind === 'added') out.push(C.green(`+ tool added: ${d.name}`));
    else if (d.kind === 'removed') out.push(C.red(`- tool removed: ${d.name}`));
    else out.push(renderToolDiff(d.name, d.oldCanonical, d.newCanonical));
  }
  return out.join('\n\n');
}

module.exports = { renderDrift, renderToolDiff, C };
