# own-load.sh: the share of a Mac's load our own work holds (sourced; POSIX sh and bash).
#
# The load line of every machine gate here is the load of our own work (2026-11-08: lane B and
# the iOS fleet's Mac half stayed shut for hours at a load of 40 to 80 while a third of the CPU
# stood idle; a video call app and security agents, which we neither own nor can stop, held most
# of the runnable threads, one of them 19 at 0.3% CPU). Over the line, the load counts only in the
# share of runnable threads our processes hold: a process that is, or descends from, Walnut, an
# agent CLI, bun, node, a test browser, Xcode's tools or a simulator (OWN_LOAD_RE on its path),
# averaged over OWN_LOAD_SAMPLES `ps -axM` samples a second apart. A share, not a subtraction: the
# samples see fewer threads than the 1-minute load counts. What the others take of the CPU and of
# memory still counts through each gate's idle and memory checks, and our own work keeps the whole
# line (a lease booted at load 48 went to 377 on the simulator's own threads).
# Off macOS (no `ps -M`), or when the samples cannot be read or show no thread of another
# process, the whole load counts. Tests name the samples with OWN_LOAD_PS_FULL
# (`ps -axww -o pid=,ppid=,comm=` output) and OWN_LOAD_PS_AXM (`ps -axM` output).
# Twin: ownLoadShare in tests/setup/cpu-idle.ts (same rule, same pattern).

OWN_LOAD_RE='(^|/)([Ww]alnut[^/]*|claude|codex|bun|bunx|node|launchd_sim|Simulator|xcodebuild|XCBBuildService|swift-frontend|Playwright|chrome-headless-shell|Google Chrome for Testing|maestro)$|/CoreSimulator/|/Xcode[^/]*\.app/|/ms-playwright/'
OWN_LOAD_SAMPLES=${OWN_LOAD_SAMPLES:-5}

# _ol_ps ARGS: /bin/ps ARGS, killed after 4 s (a ps on a swapping Mac can stall; the gate then
# counts the whole load).
_ol_ps() {
  LC_ALL=C perl -e 'my $p = fork; exit 127 unless defined $p;
    if (!$p) { exec { "/bin/ps" } "ps", @ARGV or exit 127 }
    $SIG{ALRM} = sub { kill "KILL", $p; exit 142 }; alarm 4;
    waitpid($p, 0); exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' -- "$@" 2>/dev/null </dev/null
}

# _ol_tree: pid, ppid and path of every process, from the test file or ps.
_ol_tree() {
  if [ -n "${OWN_LOAD_PS_AXM:-}" ]; then cat "$OWN_LOAD_PS_FULL"; else _ol_ps -axww -o pid=,ppid=,comm=; fi
}

# own_load_share: "<ours> <others>", the mean runnable threads of each, one decimal; nothing
# (status 1) where it cannot be read. The process tree is read before and after the samples, so a
# child our work starts or ends meanwhile (a compiler, a test worker) still counts as ours.
own_load_share() {
  _ol_tree= _ol_all= _ol_i=0
  [ -n "${OWN_LOAD_PS_AXM:-}" ] || [ "$(uname -s)" = Darwin ] || return 1
  _ol_tree=$(_ol_tree) || return 1
  while [ "$_ol_i" -lt "$OWN_LOAD_SAMPLES" ]; do
    if [ -n "${OWN_LOAD_PS_AXM:-}" ]; then _ol_s=$(cat "$OWN_LOAD_PS_AXM") || return 1
    else
      [ "$_ol_i" = 0 ] || sleep 1
      _ol_s=$(_ol_ps -axM) || return 1
    fi
    _ol_all="$_ol_all@@sample
$_ol_s
"
    _ol_i=$((_ol_i + 1))
  done
  _ol_after=$(_ol_tree) || return 1
  { printf '%s\n%s\n@@tree\n' "$_ol_tree" "$_ol_after"; printf '%s' "$_ol_all"; } | LC_ALL=C awk -v re="$OWN_LOAD_RE" '
    function ours(p,   q, i) { if (p in memo) return memo[p]; q = p
      for (i = 0; i < 40 && q > 1; i++) { if (q in mark) return memo[p] = 1; q = pp[q] }
      return memo[p] = 0 }
    !done { if ($0 == "@@tree") { done = 1; next }
      c = $0; sub(/^[ \t]*[0-9]+[ \t]+[0-9]+[ \t]+/, "", c); pp[$1] = $2; if (c ~ re) mark[$1] = 1; next }
    $0 == "@@sample" { ns++; head = 1; next }
    head { head = 0; next }
    # A process line starts with its user (STAT in field 5), a thread line with spaces (field 3).
    /^[ \t]/ { pid = $1; st = $3 }
    !/^[ \t]/ { pid = $2; st = $5 }
    st ~ /^R/ { if (ours(pid)) o++; else f++ }
    END { if (!ns) exit 1; printf "%.1f %.1f\n", o / ns, f / ns }'
}

# own_load LOAD1 CPUS MAX_PER_CPU: sets OWN_LOAD, the load to judge by: over MAX_PER_CPU per CPU,
# our share of LOAD1 (two decimals); else, or when the share cannot be read, LOAD1 itself. And
# OWN_LOAD_NOTE, how it was counted ("" when it is the whole load). Call it directly, not in $(...).
own_load() {
  OWN_LOAD=$1 OWN_LOAD_NOTE=
  awk -v l="$1" -v c="$2" -v m="$3" 'BEGIN { if (c < 1) c = 1; exit !(l / c > m) }' || return 0
  _ol_sh=$(own_load_share) || return 0
  _ol_o=${_ol_sh%% *} _ol_f=${_ol_sh#* }
  awk -v f="$_ol_f" 'BEGIN { exit !(f > 0) }' || return 0
  OWN_LOAD=$(awk -v l="$1" -v o="$_ol_o" -v f="$_ol_f" 'BEGIN { printf "%.2f", l * o / (o + f) }')
  OWN_LOAD_NOTE="the Mac's whole load is $1; our processes hold $_ol_o of $(awk -v o="$_ol_o" -v f="$_ol_f" 'BEGIN { printf "%.1f", o + f }') runnable threads, other processes $_ol_f"
}
