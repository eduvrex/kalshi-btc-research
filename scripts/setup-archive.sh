#!/usr/bin/env bash
# Hot/cold storage split: keep a lean working set on the internal SSD, park the
# bulk history on the external drive as a PostgreSQL tablespace. Research and
# model queries read across both transparently — SQL does not care where a
# table physically lives.
#
# Usage:  bash scripts/setup-archive.sh "/Volumes/YourDriveName"
#
# Requires: Postgres running; drive formatted APFS or HFS+ (NOT exFAT/FAT32 —
# those lack the POSIX permissions and fsync semantics Postgres needs).
set -u
export PATH="/usr/local/opt/postgresql@16/bin:/usr/local/bin:/usr/bin:/bin"
MOUNT="${1:-}"

if [ -z "$MOUNT" ]; then
  echo "usage: bash scripts/setup-archive.sh \"/Volumes/YourDriveName\""
  echo "available volumes:"; ls -1 /Volumes 2>/dev/null | sed 's/^/  /'
  exit 1
fi
[ -d "$MOUNT" ] || { echo "FAILED: $MOUNT does not exist"; exit 1; }
pg_isready -q || { echo "FAILED: Postgres is not running (reboot first, then scripts/recover-after-reboot.sh)"; exit 1; }

FS=$(diskutil info "$MOUNT" 2>/dev/null | awk -F: '/Type \(Bundle\)/{gsub(/ /,"",$2); print $2}')
echo "filesystem: ${FS:-unknown}"
case "$FS" in
  apfs|hfs) ;;
  exfat|msdos|ntfs)
    echo "FAILED: $FS cannot host a PostgreSQL tablespace (no POSIX permissions/fsync guarantees)."
    echo "Reformat the drive as APFS in Disk Utility, then re-run. It will erase the drive."
    exit 1 ;;
  *) echo "WARNING: unrecognized filesystem — continuing, but APFS is what you want." ;;
esac

FREE=$(df -k "$MOUNT" | awk 'NR==2{printf "%.0f", $4/1048576}')
echo "external free: ${FREE} GB"
[ "${FREE:-0}" -ge 40 ] || { echo "FAILED: need at least 40 GB free on the drive"; exit 1; }

DIR="$MOUNT/btc-research-archive"
mkdir -p "$DIR" || { echo "FAILED: cannot create $DIR"; exit 1; }
touch "$DIR/.wtest" 2>/dev/null && rm -f "$DIR/.wtest" || { echo "FAILED: $DIR is not writable"; exit 1; }
chmod 700 "$DIR"

echo "=== creating tablespace"
psql -d btc_research -c "CREATE TABLESPACE archive LOCATION '$DIR';" 2>&1 | tail -1

echo "=== moving cold data to the archive (this rewrites tables; takes a while)"
psql -d btc_research -v ON_ERROR_STOP=1 <<'SQL'
\timing on
-- Bulk history that research reads but capture never touches.
ALTER TABLE kalshi_candles_1m SET TABLESPACE archive;
ALTER TABLE spot_bars_1s     SET TABLESPACE archive;
ALTER TABLE kalshi_trades    SET TABLESPACE archive;
SQL

echo "=== archiving old capture partitions"
psql -d btc_research -f "$(dirname "$0")/archive-partitions.sql"

echo "=== reclaiming internal space"
psql -d btc_research -c "VACUUM (ANALYZE);" >/dev/null 2>&1

echo "=== result"
df -h /System/Volumes/Data | tail -1
df -h "$MOUNT" | tail -1
psql -d btc_research -t -A -F' | ' -c "
SELECT coalesce(t.spcname,'internal') AS location, pg_size_pretty(sum(pg_total_relation_size(c.oid)))
FROM pg_class c LEFT JOIN pg_tablespace t ON t.oid = c.reltablespace
WHERE c.relkind IN ('r','p') AND c.relnamespace = 'public'::regnamespace
GROUP BY 1 ORDER BY 1;"

cat <<'NOTE'

IMPORTANT — operational rules now that data lives on two disks:
  * Keep the drive plugged in whenever Postgres is running. Queries touching
    archived tables fail if it vanishes mid-flight.
  * Before unplugging: pm2 stop all && brew services stop postgresql@16
  * The retention loop now MOVES old partitions to the archive instead of
    dropping them, so nothing is lost — the internal disk just stays lean.
NOTE
