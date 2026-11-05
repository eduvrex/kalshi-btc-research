'use strict';

const crypto = require('crypto');
const fs = require('fs');
const config = require('./config');

let cachedKey = null;

function privateKey() {
  if (!cachedKey) {
    if (!config.kalshi.privateKeyPath) {
      throw new Error('KALSHI_PRIVATE_KEY_PATH is not set in .env');
    }
    cachedKey = fs.readFileSync(config.kalshi.privateKeyPath, 'utf8');
  }
  return cachedKey;
}

function haveCredentials() {
  return Boolean(config.kalshi.apiKeyId && config.kalshi.privateKeyPath);
}

// Signature = RSA-PSS-SHA256 over `${timestampMs}${METHOD}${path-without-query}`,
// salt length = digest length, per docs.kalshi.com/getting_started/api_keys.
function signHeaders(method, pathNoQuery) {
  const timestamp = String(Date.now());
  const message = timestamp + method + pathNoQuery;
  const signature = crypto
    .sign('sha256', Buffer.from(message, 'utf8'), {
      key: privateKey(),
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
    })
    .toString('base64');
  return {
    'KALSHI-ACCESS-KEY': config.kalshi.apiKeyId,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'KALSHI-ACCESS-TIMESTAMP': timestamp
  };
}

module.exports = { signHeaders, haveCredentials };
