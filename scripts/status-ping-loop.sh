#!/usr/bin/env bash
# 15-minute status heartbeat loop (PM2 cron-restart does not fire on stopped apps).
while true; do
  bash "$(dirname "$0")/status-ping.sh"
  sleep 900
done
