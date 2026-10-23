# The backup and restore tools. Same major version as the db service: pg_dump
# refuses to dump a server newer than itself, and an older pg_restore cannot
# read a newer dump.
FROM postgres:18-alpine

# age encrypts to a public key, so the server holds nothing that can read its
# own backups — the private key lives offline and is needed only to restore.
# tzdata makes BACKUP_HOUR mean local time rather than UTC.
RUN apk add --no-cache age tzdata

COPY backup.sh restore.sh /usr/local/bin/
# A Windows checkout with core.autocrlf turns these into CRLF, and sh then
# fails on "set -eu\r" with an error that names neither the file nor the cause.
RUN sed -i 's/\r$//' /usr/local/bin/backup.sh /usr/local/bin/restore.sh \
 && chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh

ENTRYPOINT ["backup.sh"]
