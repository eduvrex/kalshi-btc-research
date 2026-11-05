'use strict';

// Fuses the live data snapshot (dashboard-data.js output), the hand-written
// narrative (dashboard-narrative.json), and the HTML template into the final
// Signal Room page. Usage:
//   node scripts/dashboard-data.js > /tmp/dashboard.json
//   node scripts/build-dashboard.js /tmp/dashboard.json /tmp/signal-room.html

const fs = require('fs');
const path = require('path');

const [dataPath, outPath] = process.argv.slice(2);
if (!dataPath || !outPath) {
  console.error('usage: node scripts/build-dashboard.js <data.json> <out.html>');
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
data.narrative = JSON.parse(fs.readFileSync(path.join(__dirname, 'dashboard-narrative.json'), 'utf8'));
const template = fs.readFileSync(path.join(__dirname, 'dashboard-template.html'), 'utf8');
fs.writeFileSync(outPath, template.replace('__DATA__', JSON.stringify(data)));
console.log('wrote', outPath);
