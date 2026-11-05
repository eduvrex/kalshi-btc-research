-- Disk retention policy. Written after the 2026-08-29 disk-full incident:
-- live capture grows ~7 GB/day (deltas 5, snapshots 1.7, index ticks 0.1) and
-- this host has ~25 GB of headroom, i.e. under four days without pruning.
--
-- Windows are chosen by research value per byte:
--   book deltas      1 day  — sub-second forensics only; the 1s snapshots are
--                             the analysis unit for the seconds-scale thesis
--   book snapshots   3 days — the actual dislocation-research artifact
--   spot ticks       7 days — spot_bars_1s holds the durable aggregate
--   index ticks     30 days — small, and the proxy-vs-settlement audit needs it
--
-- Anything dropped here is either re-downloadable (Kalshi/exchange APIs) or
-- already aggregated into a durable table. Widen the windows the moment this
-- runs on a host with real disk.

DO $$
DECLARE
  r record;
  part_date date;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname ~ '^(kalshi_book_deltas|kalshi_book_snapshots|index_ticks|spot_ticks)_[0-9]{8}$'
  LOOP
    part_date := to_date(right(r.relname, 8), 'YYYYMMDD');
    IF (r.relname LIKE 'kalshi_book_deltas_%'    AND part_date < current_date - 1)
    OR (r.relname LIKE 'kalshi_book_snapshots_%' AND part_date < current_date - 3)
    OR (r.relname LIKE 'spot_ticks_%'            AND part_date < current_date - 7)
    OR (r.relname LIKE 'index_ticks_%'           AND part_date < current_date - 30)
    THEN
      RAISE NOTICE 'retention: dropping %', r.relname;
      EXECUTE format('DROP TABLE IF EXISTS %I', r.relname);
    END IF;
  END LOOP;
END $$;
