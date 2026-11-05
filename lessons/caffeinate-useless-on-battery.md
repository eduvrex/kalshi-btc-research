# caffeinate cannot keep a MacBook awake on battery power

The `-s` (prevent system sleep) assertion is honored **only on AC power** —
macOS ignores it on battery, and `-i` does not survive a closed lid either. A
`caffeinate -si` process under PM2 looked healthy all night while the machine
did "Maintenance Sleep" cycles on battery (pmset -g log: "Entering Sleep ...
Using Batt"), waking seconds at a time.

Why it mattered: the night of 2026-08-27→28 has a ~10-hour hole in the 1 Hz
index capture (hours show 21–248 ticks instead of ~3,600) and the Kalshi
backfill crawled at ~2% speed. Depth/index capture cannot be backfilled;
the hole is permanent.

Operational requirements for this Mac as a collector host:
1. Keep it **plugged in** — caffeinate then actually works.
2. System Settings → Battery → Options → "Prevent automatic sleeping on power
   adapter when the display is off" (a manual system setting).
3. The data-quality report's gap section is the tripwire: check it after any
   unattended stretch. pmset -g log | grep 'Entering Sleep' attributes gaps to
   sleep in seconds.
