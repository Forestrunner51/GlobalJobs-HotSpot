#!/bin/sh
# Refresh job postings: fetch new ones, drop closed and expired ones. Run on a schedule by the
# launchd agent that jobs/schedule.sh installs, or by hand. Output goes to jobs/logs/update.log.
set -u
cd "$(dirname "$0")/.." || exit 1

# Optional API keys (ADZUNA_APP_ID, ADZUNA_APP_KEY, USAJOBS_API_KEY, USAJOBS_EMAIL), kept out of the repo.
# shellcheck disable=SC1091
[ -f "$HOME/.config/jobglobal/env" ] && . "$HOME/.config/jobglobal/env"

mkdir -p jobs/logs
log=jobs/logs/update.log
{
  echo "== $(date '+%Y-%m-%d %H:%M:%S')"
  python3 jobs/fetch_jobs.py
  echo "exit $?"
} >> "$log" 2>&1

# Keep the log from growing without bound.
tail -n 2000 "$log" > "$log.tmp" && mv "$log.tmp" "$log"
