#!/bin/sh
# Restore a backup written by backup.sh.
#
#   restore.sh <backup>            test restore into a scratch database
#   restore.sh <backup> --live     replace the live database and sr-additions
#
# <backup> is a path under ./backups, e.g. daily/sr-2026-10-23.tar.age.
# The private key must be at ./restore/age-key.txt for the duration.
#
# The default is a test restore: the dump goes into a scratch database
# (service_records_restore, recreated each time) and the additions folder is
# unpacked under ./restore/, so you can check a backup without touching
# anything live. --live drops service_records and empties sr-additions first;
# stop the app before using it.
set -eu -o pipefail
umask 077

KEY=/restore/age-key.txt
LIVE_DB=${PGDATABASE:-service_records}
SCRATCH_DB=service_records_restore

file=${1:-}
[ -n "$file" ] || { echo "usage: restore.sh <backup under ./backups> [--live]"; exit 2; }
mode=${2:-test}
src="/backups/$file"
[ -f "$src" ] || { echo "no such backup: ./backups/$file"; exit 1; }
[ -f "$KEY" ] || { echo "private key not found: put it at ./restore/age-key.txt"; exit 1; }

work=$(mktemp -d /tmp/restore.XXXXXX)
trap 'rm -rf "$work"' EXIT

# The key is usually pasted from a password manager into Notepad, which may
# save it with a byte-order mark. age then reports "unknown identity type",
# which reads as a wrong key when it is the right one.
# (BusyBox sed has no \x escapes, so the BOM bytes come from printf.)
sed "1s/^$(printf '\357\273\277')//" "$KEY" >"$work/key"

echo "decrypting $file"
age -d -i "$work/key" "$src" | tar -C "$work" -xf -
(cd "$work" && sha256sum -c SHA256SUMS)
cat "$work/MANIFEST"

case "$mode" in
  --live) target=$LIVE_DB; additions=/srv/sr-additions ;;
  test) target=$SCRATCH_DB; additions="/restore/$(basename "$file" .tar.age)/sr-additions" ;;
  *) echo "unknown option: $mode"; exit 2 ;;
esac

echo "restoring database into $target"
# FORCE ends any open connections. On a live restore those belong to the app,
# which is why the README says to stop it first.
psql -d postgres -v ON_ERROR_STOP=1 -q \
  -c "drop database if exists \"$target\" with (force)" \
  -c "create database \"$target\""
pg_restore --exit-on-error --no-owner -d "$target" "$work/db.dump"

echo "restoring sr-additions into $additions"
mkdir -p "$additions"
find "$additions" -mindepth 1 -delete
tar -C "$work" -xf "$work/sr-additions.tar"
cp -a "$work/sr-additions/." "$additions/"

echo "row counts in $target:"
for t in users service_records access_grants access_events record_additions; do
  echo "  $t: $(psql -d "$target" -Atc "select count(*) from $t")"
done
echo "  sr-additions files: $(find "$additions" -type f | wc -l)"
echo "restore complete. Remove ./restore/age-key.txt now."
