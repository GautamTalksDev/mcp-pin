'use strict';
/*
 * Collect a complete tools/list result, including pagination.
 *
 * A single page is not a toolset. Versions <=0.1.0 fingerprinted page 1
 * and treated it as the whole server, which is a false negative under a
 * pin (and under a signed public log).
 */
const MAX_PAGES = 50;

async function collectAllTools(sendRequest) {
  if (typeof sendRequest !== 'function') throw new Error('collectAllTools: sendRequest required');

  const tools = [];
  const seen = new Set();
  let cursor;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = cursor === undefined ? undefined : { cursor };
    const result = await sendRequest('tools/list', params);
    if (!result || typeof result !== 'object') {
      throw new Error('tools/list: malformed response');
    }
    if (!Array.isArray(result.tools)) {
      throw new Error('tools/list: missing tools array');
    }
    for (const t of result.tools) tools.push(t);

    const next = result.nextCursor;
    if (next == null || next === '') {
      return sortByName(tools);
    }
    if (typeof next !== 'string') {
      throw new Error('tools/list: invalid nextCursor');
    }
    if (seen.has(next)) {
      throw new Error('tools/list: cursor loop at ' + next);
    }
    seen.add(next);
    cursor = next;
  }
  throw new Error('tools/list: exceeded ' + MAX_PAGES + ' pages');
}

function sortByName(tools) {
  // UTF-16 code unit order, same rule as fingerprintToolset, so page
  // arrival order cannot change the hash. localeCompare is not used:
  // it is locale-dependent.
  return tools.slice().sort((a, b) => {
    const an = String((a && a.name) || '');
    const bn = String((b && b.name) || '');
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

module.exports = { collectAllTools, MAX_PAGES };
