#!/bin/sh
# Daily encrypted backup of the database and ./sr-additions, taken together.
#
#   backup.sh         run forever; back up once a day at or after BACKUP_HOUR
#   backup.sh now     take one backup immediately and exit
#
# Each backup is one file, an age-encrypted tar of:
#   db.dump           pg_dump custom format (restore with pg_restore)
#   sr-additions.tar  the additions folder
#   SHA256SUMS        checksums of the two, verified on restore
#   MANIFEST          when, what server, what sizes
#
# Retention: the newest KEEP_DAILY in daily/, one per ISO week in weekly/ up to
# KEEP_WEEKLY, one per month in monthly/ up to KEEP_MONTHLY.
set -eu -o pipefail
umask 077

ROOT=/backups
ADDITIONS=/srv/sr-additions
HOUR=${BACKUP_HOUR:-2}
KEEP_DAILY=${KEEP_DAILY:-14}
KEEP_WEEKLY=${KEEP_WEEKLY:-8}
KEEP_MONTHLY=${KEEP_MONTHLY:-12}
: "${AGE_RECIPIENT:?AGE_RECIPIENT is not set; see README, Backups}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S %Z') $*"; }

prune() { # dir keep
  ls -1 "$1"/sr-*.tar.age 2>/dev/null | sort -r | tail -n +"$(($2 + 1))" |
    while read -r f; do rm -f "$f"; log "pruned $f"; done
}

run_once() {
  mkdir -p "$ROOT/daily" "$ROOT/weekly" "$ROOT/monthly"
  # One at a time: a manual `backup.sh now` can otherwise collide with the
  # scheduler's catch-up run and leave neither file intact.
  exec 9>"$ROOT/.lock"
  flock -n 9 || { log "another backup is already running"; exit 1; }

  day=$(date +%Y-%m-%d)
  out="$ROOT/daily/sr-$day.tar.age"
  partial="$out.$$.partial"
  work=$(mktemp -d /tmp/backup.XXXXXX)
  trap 'rm -rf "$work" "$partial"' EXIT

  log "backup $day: dumping database"
  pg_dump -Fc -f "$work/db.dump"
  # A dump pg_restore cannot list is not a backup. Catch it now, not on the
  # day it is needed.
  pg_restore --list "$work/db.dump" >/dev/null

  # After the dump, not before: a page uploaded in between leaves a file with
  # no row, which is harmless. The other order could leave a row whose file is
  # missing from the backup — an integrity alert after every restore.
  log "backup $day: archiving sr-additions"
  tar -C "$(dirname "$ADDITIONS")" -cf "$work/sr-additions.tar" "$(basename "$ADDITIONS")"

  (cd "$work" && sha256sum db.dump sr-additions.tar >SHA256SUMS)
  {
    echo "created:  $(date -Iseconds)"
    echo "database: $PGDATABASE on $PGHOST"
    echo "server:   $(psql -Atc 'show server_version')"
    echo "db.dump:  $(wc -c <"$work/db.dump") bytes"
    echo "sr-additions.tar: $(wc -c <"$work/sr-additions.tar") bytes"
  } >"$work/MANIFEST"

  # Written under a temporary name and renamed: a half-written file must never
  # look like today's backup, or the scheduler would consider the day done.
  tar -C "$work" -cf - MANIFEST SHA256SUMS db.dump sr-additions.tar |
    age -r "$AGE_RECIPIENT" -o "$partial"
  mv "$partial" "$out"
  log "backup $day: wrote $out ($(wc -c <"$out") bytes)"

  # Promote by "is there one for this week/month yet", not "is it Sunday/the
  # 1st": a machine that was off on the day would otherwise skip that slot.
  week="$ROOT/weekly/sr-$(date +%G-W%V).tar.age"
  month="$ROOT/monthly/sr-$(date +%Y-%m).tar.age"
  [ -f "$week" ] || { cp "$out" "$week"; log "kept as $week"; }
  [ -f "$month" ] || { cp "$out" "$month"; log "kept as $month"; }

  prune "$ROOT/daily" "$KEEP_DAILY"
  prune "$ROOT/weekly" "$KEEP_WEEKLY"
  prune "$ROOT/monthly" "$KEEP_MONTHLY"

  echo "$(date -Iseconds) $out" >"$ROOT/last-success"
}

if [ "${1:-}" = now ]; then
  run_once
  exit 0
fi

# Fail at startup, visibly, rather than at 02:00 every night.
echo | age -r "$AGE_RECIPIENT" >/dev/null || { log "AGE_RECIPIENT is not a valid age public key"; exit 1; }
log "scheduler started: daily at ${HOUR}:00 $(date +%Z), keeping $KEEP_DAILY/$KEEP_WEEKLY/$KEEP_MONTHLY"

# Checked every minute rather than slept until 02:00: if the host was off or
# asleep at 02:00, the backup runs as soon as it is back, the same day.
retry_after=0
while :; do
  hour=$(date +%H)
  if [ "${hour#0}" -ge "$HOUR" ] && [ ! -f "$ROOT/daily/sr-$(date +%Y-%m-%d).tar.age" ] &&
    [ "$(date +%s)" -ge "$retry_after" ]; then
    # A separate process, so set -e applies inside the run; in an `if` it
    # would be silently switched off.
    if "$0" now; then
      rm -f "$ROOT/last-failure"
    else
      echo "$(date -Iseconds)" >"$ROOT/last-failure"
      log "backup FAILED; retrying in an hour"
      retry_after=$(($(date +%s) + 3600))
    fi
  fi
  sleep 60
done
