#!/usr/bin/env bash
# One-shot recovery after the 2026-08-29 disk-full incident.
# Safe to re-run. Order matters: free space BEFORE capture resumes.
set -u
export PATH="${NPM_GLOBAL_BIN:-$HOME/.npm-global/bin}:/opt/homebrew/opt/postgresql@16/bin:/usr/local/opt/postgresql@16/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$0")/.."
NTFY_TOPIC="${NTFY_TOPIC:-$(grep "^NTFY_TOPIC=" .env 2>/dev/null | cut -d= -f2)}"

say() { printf '\n=== %s\n' "$1"; }

say "1/6 starting PostgreSQL"
brew services start postgresql@16 >/dev/null 2>&1
for i in $(seq 1 30); do
  pg_isready -q && break
  sleep 2
done
if ! pg_isready -q; then
  echo "FAILED: Postgres still will not start. Check the postgresql@16 log under $(brew --prefix)/var/log/"
  exit 1
fi
echo "Postgres up (WAL recovery may have run — that is expected and safe)."

say "2/6 disk before"
df -h /System/Volumes/Data | tail -1

say "3/6 freeing 22GB (kalshi_trades — backfilled data, fully re-downloadable)"
psql -d btc_research -c "TRUNCATE kalshi_trades;"
psql -d btc_research -c "UPDATE backfill_progress SET trades_done = false;"

say "4/6 installing retention policy (48h of raw deltas, 7d of book snapshots)"
psql -d btc_research -f scripts/retention.sql

say "5/6 disk after"
df -h /System/Volumes/Data | tail -1
psql -d btc_research -t -c "SELECT 'database now: ' || pg_size_pretty(pg_database_size('btc_research'));"

say "6/6 restarting collectors"
pm2 resurrect >/dev/null 2>&1 || true
pm2 start ecosystem.config.js >/dev/null 2>&1 || true
pm2 start src/report/live-board.js --name live-board >/dev/null 2>&1 || true
pm2 start src/research/paper-engine.js --name paper-engine >/dev/null 2>&1 || true
pm2 start scripts/status-ping-loop.sh --name status-ping --interpreter bash >/dev/null 2>&1 || true
pm2 start scripts/retention-loop.sh --name retention --interpreter bash >/dev/null 2>&1 || true
pm2 save >/dev/null 2>&1
pm2 list | grep -E "collector|monitor|board|paper|ping"

say "done — dashboard at http://localhost:8791"
if [ -n "${NTFY_TOPIC:-}" ]; then
  curl -s -m 10 -d "Recovery complete: Postgres up, 22GB freed, retention policy installed, collectors restarted." "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1
fi
