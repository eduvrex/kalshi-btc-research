#!/usr/bin/env bash
# Runs the retention policy every 6h, and hard-alerts if the disk gets tight.
set -u
export PATH="/usr/local/opt/postgresql@16/bin:/usr/local/bin:/usr/bin:/bin"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
TOPIC="${NTFY_TOPIC:-$(grep "^NTFY_TOPIC=" "$DIR/.env" 2>/dev/null | cut -d= -f2)}"
while true; do
  # Prefer archiving to the external drive (lossless); fall back to pruning.
  if psql -d btc_research -tAc "SELECT 1 FROM pg_tablespace WHERE spcname='archive'" 2>/dev/null | grep -q 1; then
    psql -d btc_research -f "$DIR/scripts/archive-partitions.sql" >/dev/null 2>&1
  else
    psql -d btc_research -f "$DIR/scripts/retention.sql" >/dev/null 2>&1
  fi
  FREE=$(df -k /System/Volumes/Data | awk "NR==2{print int(\$4/1048576)}")
  if [ "${FREE:-99}" -lt 8 ] && [ -n "$TOPIC" ]; then
    curl -s -m 10 -H "Priority: urgent" -H "Title: BTC research - disk low" -d "Only ${FREE}GB free. Retention ran; free space or capture will fail." "https://ntfy.sh/$TOPIC" >/dev/null
  fi
  sleep 21600
done
