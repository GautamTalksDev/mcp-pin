'use strict';
/*
 * Collect a complete tools/list (or prompts/list) result, including pagination.
 *
 * A single page is not a toolset. Versions <=0.1.0 fingerprinted page 1
 * and treated it as the whole server, which is a false negative under a
 * pin (and under a signed public log).
 */
const MAX_PAGES = 50;

async function collectAllList(sendRequest, method, field) {
  if (typeof sendRequest !== 'function') throw new Error('collectAllTools: sendRequest required');

  const items = [];
  const seen = new Set();
  let cursor;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = cursor === undefined ? undefined : { cursor };
    const result = await sendRequest(method, params);
    if (!result || typeof result !== 'object') {
      throw new Error(method + ': malformed response');
    }
    if (!Array.isArray(result[field])) {
      throw new Error(method + ': missing ' + field + ' array');
    }
    for (const t of result[field]) items.push(t);

    const next = result.nextCursor;
    if (next == null || next === '') {
      return sortByName(items);
    }
    if (typeof next !== 'string') {
      throw new Error(method + ': invalid nextCursor');
    }
    if (seen.has(next)) {
      throw new Error(method + ': cursor loop at ' + next);
    }
    seen.add(next);
    cursor = next;
  }
  throw new Error(method + ': exceeded ' + MAX_PAGES + ' pages');
}

function collectAllTools(sendRequest) {
  return collectAllList(sendRequest, 'tools/list', 'tools');
}

function collectAllPrompts(sendRequest) {
  return collectAllList(sendRequest, 'prompts/list', 'prompts');
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

module.exports = { collectAllTools, collectAllPrompts, MAX_PAGES };
