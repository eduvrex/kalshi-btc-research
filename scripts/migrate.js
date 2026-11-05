'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../src/lib/db');
const log = require('../src/lib/log');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await db.pool.query(sql);
  await db.ensurePartitions(1, 2);
  log.info('schema applied and partitions ensured');
  await db.pool.end();
}

main().catch((err) => {
  log.error('migration failed', err);
  process.exit(1);
});
