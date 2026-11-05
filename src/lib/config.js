'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const KALSHI_BASES = {
  prod: {
    rest: 'https://api.elections.kalshi.com/trade-api/v2',
    ws: 'wss://api.elections.kalshi.com/trade-api/ws/v2',
    wsSignPath: '/trade-api/ws/v2'
  },
  demo: {
    rest: 'https://demo-api.kalshi.co/trade-api/v2',
    ws: 'wss://demo-api.kalshi.co/trade-api/ws/v2',
    wsSignPath: '/trade-api/ws/v2'
  }
};

const env = (process.env.KALSHI_ENV || 'prod').toLowerCase();
if (!KALSHI_BASES[env]) {
  throw new Error(`KALSHI_ENV must be prod or demo, got: ${env}`);
}

module.exports = {
  pg: {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'btc_research',
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD
  },
  kalshi: {
    env,
    rest: KALSHI_BASES[env].rest,
    ws: KALSHI_BASES[env].ws,
    wsSignPath: KALSHI_BASES[env].wsSignPath,
    apiKeyId: process.env.KALSHI_API_KEY_ID || '',
    privateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH || '',
    series: (process.env.KALSHI_SERIES || 'KXBTC15M,KXBTC')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  },
  backfillDays: Number(process.env.BACKFILL_DAYS || 90),
  pythApiKey: process.env.PYTH_API_KEY || '',
  ntfyTopic: process.env.NTFY_TOPIC || '',
  dislocation: {
    minGap: Number(process.env.DISLOC_MIN_GAP || 0.03),
    minRunS: Number(process.env.DISLOC_MIN_RUN_S || 3),
    alertCooldownS: Number(process.env.DISLOC_ALERT_COOLDOWN_S || 60)
  },
  snapshotIntervalMs: Number(process.env.SNAPSHOT_INTERVAL_MS || 1000),
  forceSnapshotEveryMs: Number(process.env.FORCE_SNAPSHOT_EVERY_MS || 30000),
  discoveryIntervalMs: Number(process.env.DISCOVERY_INTERVAL_MS || 30000)
};
