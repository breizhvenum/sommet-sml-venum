#!/usr/bin/env bash
# Scheduled driver for tools/backup_all.py - meant to be run from cron every so often.
#
# It is deliberately quiet:
#   - does nothing if the project folder is gone (an external drive that is not mounted);
#   - takes a non-blocking lock so two runs never overlap on the USB bus;
#   - runs the backup in --quiet --skip-unchanged mode (no new copy when nothing changed);
#   - logs only when a backup was actually made or an error happened - a run that finds no watch
#     on the bus (the usual case) is silent, so the log does not fill with "no watch" lines.
#
# Install, e.g. every 30 minutes (crontab -e):
#   */30 * * * * /path/to/sommet/tools/backup_all_cron.sh
# Optional: AMBIT_BACKUP_MODEL=Emu (only back up a watch reporting this model; Emu = Ambit3 Peak),
# AMBIT_PROJECT=/path/to/sommet (default: the folder this script sits in).
#
# Read-only against the watch: it only ever calls backup_all.py, which cannot write to the watch.
set -u
export PATH="/usr/bin:/bin:$PATH"

PROJECT="${AMBIT_PROJECT:-$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)}"
PY="$(command -v python3 || echo /usr/bin/python3)"
LOCK="${XDG_RUNTIME_DIR:-/tmp}/ambit_backup_all.lock"
LOG="$PROJECT/backups/backup_all.log"

# Drive not mounted / project missing -> nothing to do, no noise.
[ -n "$PROJECT" ] && [ -d "$PROJECT/tools" ] || exit 0

# Serialise: if a previous run is still going (slow USB, big log), skip this tick quietly.
exec 9>"$LOCK"
flock -n 9 || exit 0

args=(--skip-unchanged --quiet)
[ -n "${AMBIT_BACKUP_MODEL:-}" ] && args+=(--expect-model "$AMBIT_BACKUP_MODEL")
out="$("$PY" "$PROJECT/tools/backup_all.py" "${args[@]}" 2>&1)"
rc=$?

# rc 2 == no watch on the bus (the normal idle case) -> stay silent. Anything else is worth a line.
if [ "$rc" -ne 2 ]; then
    mkdir -p "$PROJECT/backups"
    printf '%s  rc=%s  %s\n' "$(date -Is)" "$rc" "$out" >> "$LOG"
fi
exit 0
