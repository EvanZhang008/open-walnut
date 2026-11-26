#!/bin/sh
# Rehearsal (b): the other machine's rehearsal root, made fresh (real-world.ts runs it before anything else there):
#
#   ssh <host> sh -s -- <root> <run id> < scripts/leader-switch/real/make-root.sh
#
# Refuses a <root> that exists (an earlier run's: clean it with cleanup.sh first). Owner only (umask 077).
# <root>/run/started is this shell's start in clock ticks since boot: cleanup.sh ends only processes started after it.
set -eu
ROOT=${1:-}
RUN=${2:-}
case "$ROOT" in
  /*/*) ;;
  *) echo "make-root: refusing root '$ROOT': an absolute folder at least two levels deep"; exit 2 ;;
esac
ROOT=${ROOT%/}
if [ -e "$ROOT" ]; then
  echo "make-root: $ROOT exists (an earlier run's?): clean it first with cleanup.sh; nothing done"
  exit 2
fi
umask 077
mkdir -p "$ROOT/run" "$ROOT/code" "$ROOT/bin" "$ROOT/tmp" "$ROOT/tls" "$ROOT/machine"
s=$(cat /proc/$$/stat)
rest=${s##*) }
echo "$rest" | awk '{print $20}' > "$ROOT/run/started"
echo "$RUN" > "$ROOT/run/id"
: > "$ROOT/run/pids.jsonl"
for n in crontab systemctl ssh claude; do
  printf '#!/bin/sh\necho "%s is disabled on this rehearsal machine" >&2\nexit 1\n' "$n" > "$ROOT/bin/$n"
  chmod 755 "$ROOT/bin/$n"
done
echo "make-root: $ROOT made (started tick $(cat "$ROOT/run/started"), run $RUN)"
