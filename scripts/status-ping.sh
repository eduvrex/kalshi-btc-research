#!/usr/bin/env bash
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
TOPIC="${NTFY_TOPIC:-$(grep '^NTFY_TOPIC=' "$DIR/.env" 2>/dev/null | cut -d= -f2)}"
if [ -z "$TOPIC" ]; then exit 0; fi

PM2_STATUS="$(pm2 jlist 2>/dev/null | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try{const a=JSON.parse(d);console.log(a.map(p=>p.name+':'+p.pm2_env.status).join(' '))}catch{console.log('pm2:unknown')}
})" 2>/dev/null)"

DB_LINE="$(psql -X -t -A -d btc_research -c "
SELECT 'snaps:'||coalesce((SELECT count(*) FROM kalshi_book_snapshots WHERE ts>now()-interval '15 minutes'),0)
 ||' trades:'||coalesce((SELECT count(*) FROM kalshi_trades WHERE received_at>now()-interval '15 minutes'),0)
 ||' idx:'||coalesce((SELECT count(*) FROM index_ticks WHERE ts>now()-interval '15 minutes'),0)
 ||' hb:'||coalesce((SELECT count(DISTINCT collector) FROM collector_heartbeats WHERE ts>now()-interval '2 minutes'),0)
" 2>/dev/null)"

DISK="$(df -h / | awk 'NR==2{print $5}')"
JOB="$(cat "$DIR/.current-job" 2>/dev/null || echo idle)"

MSG="BTC ${JOB} | ${PM2_STATUS:-pm2:n/a} | ${DB_LINE:-db:n/a} | disk:${DISK}"
curl -s -m 10 -H "Title: BTC research" -d "$MSG" "https://ntfy.sh/$TOPIC" > /dev/null
