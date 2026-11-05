-- Moves aged capture partitions to the external 'archive' tablespace instead
-- of dropping them: the internal SSD keeps only the working set, while every
-- byte of history stays queryable. Model/research SQL is unchanged — Postgres
-- resolves the location transparently.
--
-- No-op when the archive tablespace does not exist (no drive attached); in
-- that case scripts/retention.sql does the lossy pruning instead.
--
-- Age thresholds match retention.sql so the two policies agree on what "hot"
-- means: deltas 1d, book snapshots 3d, spot ticks 7d, index ticks 30d.

DO $$
DECLARE
  r record;
  part_date date;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tablespace WHERE spcname = 'archive') THEN
    RAISE NOTICE 'archive tablespace absent — nothing to do';
    RETURN;
  END IF;

  FOR r IN
    SELECT c.relname, coalesce(t.spcname, 'internal') AS loc
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_tablespace t ON t.oid = c.reltablespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname ~ '^(kalshi_book_deltas|kalshi_book_snapshots|index_ticks|spot_ticks)_[0-9]{8}$'
  LOOP
    CONTINUE WHEN r.loc = 'archive';
    part_date := to_date(right(r.relname, 8), 'YYYYMMDD');
    IF (r.relname LIKE 'kalshi_book_deltas_%'    AND part_date < current_date - 1)
    OR (r.relname LIKE 'kalshi_book_snapshots_%' AND part_date < current_date - 3)
    OR (r.relname LIKE 'spot_ticks_%'            AND part_date < current_date - 7)
    OR (r.relname LIKE 'index_ticks_%'           AND part_date < current_date - 30)
    THEN
      RAISE NOTICE 'archiving %', r.relname;
      EXECUTE format('ALTER TABLE %I SET TABLESPACE archive', r.relname);
    END IF;
  END LOOP;
END $$;
