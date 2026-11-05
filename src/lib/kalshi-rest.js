'use strict';

const config = require('./config');
const auth = require('./kalshi-auth');
const log = require('./log');

const REST_PATH_PREFIX = '/trade-api/v2';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// GET against the Kalshi REST API. Market-data endpoints work unauthenticated,
// but we sign when credentials exist to get the documented token budget.
// Retries on 429 and 5xx with exponential backoff.
async function get(pathWithQuery, { authenticated = true, maxRetries = 6 } = {}) {
  const url = config.kalshi.rest + pathWithQuery;
  const pathNoQuery = REST_PATH_PREFIX + pathWithQuery.split('?')[0];
  let attempt = 0;
  for (;;) {
    const headers = { Accept: 'application/json' };
    if (authenticated && auth.haveCredentials()) {
      Object.assign(headers, auth.signHeaders('GET', pathNoQuery));
    }
    let res;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      attempt += 1;
      await sleep(Math.min(30000, 500 * 2 ** attempt));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= maxRetries) {
        throw new Error(`kalshi GET ${pathWithQuery} failed: HTTP ${res.status}`);
      }
      attempt += 1;
      const wait = Math.min(30000, 500 * 2 ** attempt);
      log.warn(`kalshi GET ${pathWithQuery} HTTP ${res.status}, retry in ${wait}ms`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`kalshi GET ${pathWithQuery} HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    return res.json();
  }
}

// Cursor-paginated GET, concatenating `field` across pages.
async function getAllPages(basePath, field, { maxPages = 1000, throttleMs = 150 } = {}) {
  const out = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page++) {
    const sep = basePath.includes('?') ? '&' : '?';
    const path = cursor ? `${basePath}${sep}cursor=${encodeURIComponent(cursor)}` : basePath;
    const data = await get(path);
    const items = data[field] || [];
    out.push(...items);
    cursor = data.cursor || '';
    if (!cursor || items.length === 0) break;
    if (throttleMs) await sleep(throttleMs);
  }
  return out;
}

module.exports = { get, getAllPages, sleep };
