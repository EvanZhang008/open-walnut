#!/bin/sh
# A stand-in `ssh` for tests/providers/daemon-connection-upload-fake-ssh.test.ts:
# it runs the remote command here with `sh -c`, as the host would. State lives in
# $FAKE_SSH_STATE, in files the test writes:
#   max-bytes     a transfer bigger than this many bytes is cut after half of it
#   fail-once     a chunk name (chunk_0003): that chunk is cut once
#   refuse-after  a chunk name: once it went through, every connection is refused
#   refused       present: every connection is refused
#   hide/         first on the command's PATH (stubs for tools the "host" lacks)
#   log           one line per call, "<kind> <ok|cut|refused>" (exec, stream, chunk_NNNN)
# A cut or a refusal exits 255 with "Connection closed by UNKNOWN port 65535", as
# a proxy that kills the connection does; a cut first hands half of stdin to the
# command, so the host keeps a partial file. Builtins wherever possible: every
# fork counts on a loaded machine.
S=$FAKE_SSH_STATE
while [ $# -gt 0 ]; do
  case $1 in
    -o|-p|-i|-l|-F) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
shift
cmd=$*
case $cmd in
  'sh -s') kind=exec ;;
  *chunk_[0-9]*) rest=${cmd#*chunk_}; kind=chunk_${rest%%[!0-9]*} ;;
  *) kind=stream ;;
esac
note() { echo "$kind $1" >> "$S/log"; }
closed() { echo 'Connection closed by UNKNOWN port 65535' >&2; exit 255; }
if [ -f "$S/refused" ]; then cat > /dev/null; note refused; closed; fi
max=0; once=; after=
[ -f "$S/max-bytes" ] && read -r max < "$S/max-bytes"
[ -f "$S/fail-once" ] && read -r once < "$S/fail-once"
[ -f "$S/refuse-after" ] && read -r after < "$S/refuse-after"
PATH=$S/hide:$PATH
export PATH
cut=no
if [ "$kind" = "$once" ] && [ ! -f "$S/failed-$kind" ]; then : > "$S/failed-$kind"; cut=yes; fi
# `eval` is the login shell's `-c`: one process fewer than `sh -c "$cmd"`. The
# stdin copy stays in the state dir (the test removes it), sparing an `rm`.
if [ "$max" -gt 0 ] || [ "$cut" = yes ]; then
  in=$S/stdin.$$
  cat > "$in"
  size=$(wc -c < "$in")
  if [ "$max" -gt 0 ] && [ $((size)) -gt "$max" ]; then cut=yes; fi
  if [ "$cut" = yes ]; then
    head -c $((size / 2)) "$in" | eval "$cmd" > /dev/null 2>&1
    note cut
    closed
  fi
  eval "$cmd" < "$in"
  rc=$?
else
  eval "$cmd"
  rc=$?
fi
note ok
if [ -n "$after" ] && [ "$kind" = "$after" ]; then : > "$S/refused"; fi
exit $rc
