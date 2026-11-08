/**
 * The PreToolUse hook (matcher `Bash`) that refuses a command making sound on
 * the machine it runs on: speech (`say` without `-o`, espeak), a player
 * (afplay, aplay, paplay, mpv...), a volume change or an unmute (osascript
 * `set volume`, amixer, pactl, pamixer, wpctl), a media app told to play, and
 * the same from an interpreter's inline code (`python3 -c`, `node -e`). Rules:
 * sound-rules.ts, shared with the TypeScript twin host_exec runs on the server
 * (sound-guard.ts); one case table runs through both.
 *
 * Why (2026-11-07, at night): a voice test on someone else's Mac ran
 * `ssh mac "osascript -e 'set volume output volume 70 without output muted'"`,
 * then spoke and played music through its speakers. A standing rule in the
 * user's profile did not stop it.
 *
 * What counts as run: every simple command (after `;`, `&`, `|`, `(`, a newline,
 * shell keywords, wrappers such as sudo, env, timeout, xargs), the inside of a
 * backtick or `$(...)` (also in double quotes and an unquoted heredoc body), the
 * script a shell runs (`bash -c`, its heredoc, a herestring, words piped into it),
 * eval, `su -c`, `ssh host cmd` and a heredoc fed to ssh, find's -exec, the
 * AppleScript osascript runs (-e, heredoc, piped), and an interpreter's inline
 * code. A word that only names a player (`grep afplay`, `echo "say -o"`) and a
 * quoted heredoc written to a file are left alone; a script file is not read.
 *
 * POSIX sh + awk, like the kill guard (pattern-kill-guard-hook.ts), plus base64 and
 * gzip to unpack the program; where those are missing the hook allows. A command
 * over 100,000 characters is not parsed: it is refused when it names afplay or
 * `set volume` anywhere. WALNUT_SOUND_GUARD=0 on the server turns it off.
 */
import { gzipSync } from 'node:zlib'
import { JSON_AWK } from './tmp-path-awk.js'
import {
  ALWAYS_PLAYS, AUDIO_FILE_RE, CODE_AUDIO_API_RE, CODE_SPAWN_RE, FFMPEG_AUDIO_OUT_RE, JXA_MUTE_ONLY_RE, MEDIA_APPS_RE,
  OSA_BEEP_RE, OSA_JXA_VOLUME_RE, OSA_MEDIA_TELL_RE, OSA_MUTE_ONLY_RE, OSA_PLAY_RE, OSA_SAVING_RE, OSA_SAY_RE,
  OSA_SET_VOLUME_RE, OSA_SHELL_RE, OSA_APP_VOLUME_RE, STRING_RE, soundAdvice,
} from './sound-rules.js'

/** A string as an awk string literal (a regex of sound-rules.ts is used as a dynamic regex) ("..."), its backslashes doubled. */
// A \t or \n becomes the character itself first: busybox awk reads "\\t" inside a bracket as a t.
const s = (re: string) => '"' + re.replace(/\\t/g, '\t').replace(/\\n/g, '\n').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"'
/** The refusal around what was found, which awk puts between. */
const [ADVICE_PRE, ADVICE_POST] = soundAdvice('\u0000').split('\u0000')

const SOUND_AWK = JSON_AWK + String.raw`
function base(w,   k) { k = w; sub(/^.*\//, "", k); return k }
function isshell(w) { return w ~ /^(ba|z|da|k|mk|y|c|tc|a)?sh$/ || w == "fish" }
function hit(what) { if (found == "") found = what }
function closer(s, i,   n, lvl, c, q, hd, tab, rest, m, L, k, t) {
  n = length(s); lvl = 1; q = ""; hd = ""
  for (; i <= n; i++) {
    c = substr(s, i, 1)
    if (q != "") { if (c == q) q = ""; else if (c == "\\" && q == "\"") i++; continue }
    if (c == "\\") { i++; continue }
    if (c == "'" || c == "\"") { q = c; continue }
    if (c == "<" && substr(s, i, 2) == "<<" && substr(s, i, 3) != "<<<") {
      i += 2; tab = 0; if (substr(s, i, 1) == "-") { tab = 1; i++ }
      while (substr(s, i, 1) == " ") i++
      hd = ""
      while (i <= n && substr(s, i, 1) !~ /[ \t\n;&|<>()]/) { c = substr(s, i, 1); if (c != "'" && c != "\"" && c != "\\") hd = hd c; i++ }
      i--; continue
    }
    if (c == "\n" && hd != "") {
      rest = substr(s, i + 1); m = split(rest, L, "\n")
      for (k = 1; k <= m; k++) { i += length(L[k]) + 1; t = L[k]; if (tab) sub(/^[ \t]+/, "", t); if (t == hd) break }
      hd = ""; continue
    }
    if (c == "(") lvl++
    else if (c == ")" && --lvl == 0) return i
  }
  return n + 1
}
function tick(s, i,   n) {
  n = length(s)
  for (i++; i <= n; i++) { if (substr(s, i, 1) == "\\") { i++; continue } if (substr(s, i, 1) == "\140") return i }
  return n + 1
}
# Only the command substitutions in s (an unquoted heredoc body, a parameter expansion).
function subs(s, d,   n, i, c, j) {
  n = length(s)
  for (i = 1; i <= n && found == ""; i++) {
    c = substr(s, i, 1)
    if (c == "\\") { i++; continue }
    if (c == "\140") { j = tick(s, i); scan(substr(s, i + 1, j - i - 1), d + 1); i = j; continue }
    if (c == "$" && substr(s, i + 1, 1) == "(" && substr(s, i + 2, 1) != "(") { j = closer(s, i + 2); scan(substr(s, i + 2, j - i - 2), d + 1); i = j }
  }
}
# ── The commands of one line at depth d: CW[d,ci,k] its words, CN[d,ci] their count,
# CI[d,ci] its stdin text (heredoc bodies, herestrings), CP[d,ci] 1 when a pipe feeds it.
function newcmd(d, piped) { NC[d]++; CN[d, NC[d]] = 0; CI[d, NC[d]] = ""; CP[d, NC[d]] = piped; HS[d] = 0 }
function word(d, w) {
  if (w == "") return
  if (HS[d]) { CI[d, NC[d]] = CI[d, NC[d]] w "\n"; HS[d] = 0; return }
  CW[d, NC[d], ++CN[d, NC[d]]] = w
}
# The arguments of command ci from index j on, redirections left out, into ARGS (count returned).
function args(d, ci, j, ARGS,   n, k, w) {
  n = 0
  for (k = j; k <= CN[d, ci]; k++) {
    w = CW[d, ci, k]
    if (w ~ /^[0-9]*(>|>>|<|&>|&>>|>&|<&|<>|>\|)$/) { k++; continue }
    if (w ~ /^[0-9]*[<>]/ || w ~ /^&>/) continue
    ARGS[++n] = w
  }
  return n
}
# What a shell given these words would read on stdin, scanned as commands: its stdin text,
# then every word and stdin text of the commands piped into it.
function shellstdin(d, ci,   p, k) {
  scan(CI[d, ci], d + 1)
  for (p = ci; CP[d, p] && p > 1 && found == ""; p--) {
    for (k = 1; k <= CN[d, p - 1]; k++) scan(CW[d, p - 1, k], d + 1)
    scan(CI[d, p - 1], d + 1)
  }
}
# The text a program reads on stdin, as data: its own, then that of the commands piped into it.
function stdintext(d, ci,   t, p, k) {
  t = CI[d, ci]
  for (p = ci; CP[d, p] && p > 1; p--) { for (k = 1; k <= CN[d, p - 1]; k++) t = t " " CW[d, p - 1, k]; t = t "\n" CI[d, p - 1] }
  return t
}
function has(A, n, f,   k) { for (k = 1; k <= n; k++) if (A[k] == f) return k; return 0 }
function after(A, n, f,   k) { k = has(A, n, f); return k && k < n ? A[k + 1] : "\001" }
# The string literal opening at s[i]: LIT its text (escapes read), LITEND the index after it.
function lit(s, i,   q, k, c, n) {
  q = substr(s, i, 1); if (q != "\"" && q != "'" && q != "\140") return 0
  LIT = ""; n = length(s)
  for (k = i + 1; k <= n; k++) {
    c = substr(s, k, 1)
    if (c == "\\" && k < n) { c = substr(s, ++k, 1); LIT = LIT (c == "n" ? "\n" : c == "t" ? "\t" : c); continue }
    if (c == q) { LITEND = k + 1; return 1 }
    LIT = LIT c
  }
  return 0
}
function skipsp(s, i) { while (substr(s, i, 1) ~ /[ \t\n]/) i++; return i }
# A word single-quoted for a shell line: nothing in it expands.
function sq(w,   out, k, c) {
  out = "'"
  for (k = 1; k <= length(w); k++) { c = substr(w, k, 1); out = out (c == "'" ? "'\"'\"'" : c) }
  return out "'"
}
# The string items of the list opening at s[i] ("["), as a shell line of single-quoted words.
function items(s, i,   out) {
  out = ""
  for (i++; ; ) {
    i = skipsp(s, i)
    if (substr(s, i, 1) == ",") { i++; continue }
    if (!lit(s, i)) return out
    out = out (out == "" ? "" : " ") sq(LIT); i = LITEND
  }
}
# Whether a string literal is open at s[at]: a call named inside a string runs nothing.
function instr(s, at,   k, c, q) {
  q = ""
  for (k = 1; k < at; k++) {
    c = substr(s, k, 1)
    if (q != "") { if (c == "\\") k++; else if (c == q) q = "" }
    else if (c == "\"" || c == "'" || c == "\140") q = c
  }
  return q != ""
}
# The command lines a script's code starts (each process call's first argument and its argv list), judged as shell lines.
function spawned(raw, d,   t, off, i, j, m, line) {
  t = tolower(raw); off = 0
  while (found == "" && match(substr(t, off + 1), ${s(CODE_SPAWN_RE)})) {
    m = substr(t, off + RSTART, RLENGTH); i = off + RSTART + RLENGTH; off += RSTART
    if (instr(raw, off)) continue
    if (m == "$\140") { if (lit(raw, i - 1)) scan(LIT, d + 1); continue }
    # Python: args=[...], and f"...", r"...", b"..." strings.
    if (match(substr(raw, i), /^args[ \t]*=[ \t]*/)) i += RLENGTH
    if (substr(raw, i, 1) == "[") { scan(items(raw, i), d + 1); continue }
    if (substr(raw, i, 2) ~ /^[fFrRbBuU]["']/) i++
    else if (substr(raw, i, 3) ~ /^[fFrRbB][fFrRbB]["']/) i += 2
    if (!lit(raw, i)) continue
    line = LIT; j = skipsp(raw, LITEND)
    if (substr(raw, j, 1) == ",") j = skipsp(raw, j + 1)
    if (substr(raw, j, 1) == "[") line = sq(line) " " items(raw, j)
    scan(line, d + 1)
  }
}
# An AppleScript say (strings emptied) with no "saving to" after it on its line: it speaks.
function speaks(t0,   r, rest) {
  r = t0
  while (match(r, ${s(OSA_SAY_RE)})) {
    rest = substr(r, RSTART + RLENGTH - (substr(r, RSTART + RLENGTH - 1, 1) == "y" ? 0 : 1))
    if (match(rest, /\n/)) rest = substr(rest, 1, RSTART - 1)
    if (rest !~ ${s(OSA_SAVING_RE)}) return 1
    match(r, ${s(OSA_SAY_RE)}); r = substr(r, RSTART + RLENGTH)
  }
  return 0
}
function osahit(raw, d,   t, t0, off, r, at, j) {
  t = tolower(raw); off = 0
  while (found == "" && match(substr(t, off + 1), ${s(OSA_SHELL_RE)})) {
    j = off + RSTART + RLENGTH; off += RSTART
    if (lit(raw, j)) scan(LIT, d + 1)
  }
  if (found != "") return ""
  t0 = t; gsub(${s(STRING_RE)}, "\"\"", t0)
  if (speaks(t0)) return "AppleScript say"
  if (t0 ~ ${s(OSA_BEEP_RE)}) return "AppleScript beep"
  if (t ~ ${s(OSA_MEDIA_TELL_RE)} && t0 ~ ${s(OSA_PLAY_RE)}) return "a media app told to play"
  if (t0 ~ ${s(OSA_APP_VOLUME_RE)}) return "an app volume change"
  r = t0; at = 0
  while ((j = index(r, ${s(OSA_SET_VOLUME_RE)})) > 0) {
    at += j
    r = substr(t0, at); if (match(r, /[\n;]/)) r = substr(r, 1, RSTART - 1)
    sub(/(--|#).*$/, "", r)
    if (r !~ ${s(OSA_MUTE_ONLY_RE)}) return "set volume"
    r = substr(t0, at + 1)
  }
  off = 0
  while (match(substr(t, off + 1), ${s(OSA_JXA_VOLUME_RE)})) {
    off += RSTART
    if (substr(t, off) !~ ${s(JXA_MUTE_ONLY_RE)}) return "setVolume"
  }
  return ""
}
# Code: an audio API outside its strings, or a process it starts that would make sound.
function codehit(raw, d,   t2) {
  t2 = tolower(raw); gsub(${s(STRING_RE)}, "\"\"", t2)
  if (t2 ~ ${s(CODE_AUDIO_API_RE)}) return "an audio or speech API"
  spawned(raw, d)
  return ""
}
# Inline code from flags F (" -c -e "), also attached (-c'code', --eval=code): sets CODE and returns 1, 2 for stdin, 0 for a file.
function inline(A, n, F, deno,   k, e) {
  CODE = ""
  for (k = 1; k <= n; k++) {
    if (index(F, " " A[k] " ")) { if (k < n) CODE = CODE A[++k] "\n"; continue }
    e = index(A[k], "=")
    if (A[k] ~ /^--/ && e > 1 && index(F, " " substr(A[k], 1, e - 1) " ")) { CODE = CODE substr(A[k], e + 1) "\n"; continue }
    if (length(A[k]) > 2 && substr(A[k], 1, 2) ~ /^-[A-Za-z]$/ && index(F, " " substr(A[k], 1, 2) " ")) { CODE = CODE substr(A[k], 3) "\n"; continue }
    if (CODE != "") return 1
    if (deno && A[k] == "eval") { if (k < n) { CODE = A[k + 1]; return 1 } return 0 }
    if (A[k] == "-") return 2
    if (A[k] ~ /^-./) continue
    return 0
  }
  return CODE != "" ? 1 : 2
}
function anyre(A, n, re,   k) { for (k = 1; k <= n; k++) if (A[k] ~ re) return 1; return 0 }
# Programs that play unless an argument makes them silent (OK), or only with one (ON).
# mpv / mplayer: whether the last option that picks audio output turns it off.
# Two settings, each last-wins: the output device (--ao) and whether an audio track plays at all.
function lastsilent(name, A, n,   k, v, nullout, notrack) {
  nullout = 0; notrack = 0
  for (k = 1; k <= n; k++) {
    v = "\001"
    if (A[k] == (name == "mpv" ? "--ao" : "-ao")) v = k < n ? A[++k] : ""
    else if (A[k] ~ /^--?ao=/) { v = A[k]; sub(/^[^=]*=/, "", v) }
    if (v != "\001") nullout = v == "null"
    else if (A[k] ~ /^(--no-audio|--audio=no|--aid=no|-nosound)$/) notrack = 1
    else if (A[k] ~ /^(--(audio|aid)=.*|-sound)$/) notrack = 0
  }
  return nullout || notrack
}
function prog(name, A, n,   k, v, first, dev, j, sub1) {
  if (index(" ${ALWAYS_PLAYS.join(' ')} ", " " name " ")) return name
  # Options end at --: what follows is text, except open's files.
  k = has(A, n, "--")
  if (name == "open" || name == "xdg-open") {
    v = after(A, k ? k - 1 : n, "-a")
    if (v != "\001" && tolower(v) ~ ${s(MEDIA_APPS_RE)}) return "open -a " v
    for (j = 1; j <= n; j++) if (j != k && ((k && j > k) || A[j] !~ /^-/) && A[j] != v && tolower(A[j]) ~ ${s(AUDIO_FILE_RE)}) return name " " A[j]
    return ""
  }
  if (k) n = k - 1
  if (name == "mpv" || name == "mplayer") return lastsilent(name, A, n) ? "" : name
  if (name in OK) return anyre(A, n, OK[name]) || (name == "say" && after(A, n, "-v") == "?") ? "" : name
  if (name in ON) return anyre(A, n, ON[name]) ? name : ""
  if (name == "sox") {
    first = 0; dev = 0
    for (k = 1; k <= n; k++) { if (!first && (A[k] !~ /^-/ || A[k] == "-n" || A[k] == "--null")) first = k; if (!dev && (A[k] == "-d" || A[k] == "--default-device")) dev = k }
    return first && dev > first ? "sox to the default device" : ""
  }
  # ffmpeg: -f <device> is the next file's format, an output unless -i comes first.
  if (name == "ffmpeg") {
    for (k = 1; k < n; k++) {
      if (A[k] != "-f" || tolower(A[k + 1]) !~ ${s(FFMPEG_AUDIO_OUT_RE)}) continue
      for (j = k + 2; j <= n && A[j] ~ /^-./ && A[j] != "-i"; ) j += A[j] ~ /^-(y|n|an|vn|sn|dn|nostdin|re|hide_banner|stats|nostats)$/ ? 1 : 2
      if (A[j] != "-i") return "ffmpeg to " A[k + 1]
    }
    return ""
  }
  # Mixers: a mute alone passes; any level (0 too), an unmute or a toggle does not.
  if (name == "amixer") {
    for (k = 1; k <= n; k++) if (A[k] ~ /^c?s?set$/) break
    for (k += 2; k <= n; k++) if (A[k] ~ /^(unmute|on|toggle)$/ || A[k] ~ /[0-9]/) return "amixer set"
    return ""
  }
  if (name == "pactl" || name == "wpctl") {
    for (k = 1; k <= n && A[k] ~ /^-/; k++) if (A[k] ~ /^(-s|--server|-n|--client-name)$/) k++
    sub1 = k <= n ? A[k] : ""
    if (sub1 ~ /^set-(sink|sink-input)-volume$|^set-volume$|^play-sample$/) return name " " sub1
    if (sub1 ~ /^set-(sink|sink-input)-mute$|^set-mute$/) return A[n] ~ /^(1|true|yes|on)$/ ? "" : name " " sub1
    return ""
  }
  if (name == "pamixer") return anyre(A, n, "^(-u|--unmute|-t|--toggle-mute|-i[0-9]*|--increase|-d[0-9]*|--decrease|--set-volume|--allow-boost)(=.*)?$") ? "pamixer" : ""
  return ""
}
# Options of a wrapper that take a value.
function wrapopt(b, w) {
  if (b == "sudo") return w ~ /^-[ughpCDrtUT]$/ || w ~ /^--(user|group|host|prompt|chdir|role|type|other-user|close-from|command-timeout)$/
  if (b == "doas") return w ~ /^-[uC]$/
  if (b == "env") return w ~ /^-[uCPS]$/ || w ~ /^--(unset|chdir|split-string)$/
  if (b == "exec") return w == "-a"
  if (b == "time") return w ~ /^-[of]$/
  if (b == "nice") return w == "-n" || w == "--adjustment"
  if (b == "caffeinate") return w ~ /^-[wt]$/
  if (b == "stdbuf") return w ~ /^-[ioe]$/
  if (b == "ionice") return w ~ /^-[cnp]$/
  if (b == "timeout" || b == "gtimeout") return w ~ /^-[sk]$/ || w ~ /^--(signal|kill-after)$/
  if (b == "watch") return w ~ /^-[nq]$/ || w ~ /^--(interval|equexit)$/
  if (b == "xargs") return w ~ /^-[nILPsEdaJRS]$/ || w ~ /^--(max-args|replace|max-lines|max-procs|delimiter|arg-file|eof)$/
  if (b == "arch") return w ~ /^-(arch|e|d)$/
  return 0
}
# Judge command ci of depth d from its word j on.
function judge(d, ci, j, exec,   n, w, b, A, na, k, r, F) {
  n = CN[d, ci]
  for (; j <= n; j++) {
    w = CW[d, ci, j]
    if (w ~ /^[0-9]*(>|>>|<|&>|&>>|>&|<&|<>|>\|)$/) { j++; continue }
    if (w ~ /^[A-Za-z_][A-Za-z0-9_]*\+?=/ || w ~ /^[0-9]*[<>]/ || w ~ /^&>/) continue
    if (w ~ /^(if|then|else|elif|do|while|until|!|\{|\}|fi|done|esac|coproc)$/) continue
    b = base(w)
    if (b !~ /^(sudo|doas|env|command|exec|nohup|time|nice|ionice|timeout|gtimeout|xargs|builtin|caffeinate|stdbuf|setsid|unbuffer|watch|arch|launchctl)$/) break
    if (b == "launchctl") { if (CW[d, ci, j + 1] ~ /^(asuser|bsexec)$/) { j += 2; continue } return }
    for (j++; j <= n; j++) {
      w = CW[d, ci, j]
      if (b == "command" && w ~ /^-[vV]$/) return
      # env -S 'cmd args': the string is the command line.
      if (b == "env" && w ~ /^(-S|--split-string)/) {
        r = w; sub(/^(-S|--split-string=?)/, "", r)
        for (k = j + 1; k <= n; k++) r = r " " CW[d, ci, k]
        scan(r, d + 1); return
      }
      if (w == "--") { j++; break }
      if (w ~ /^-./) { if (wrapopt(b, w)) j++; continue }
      if ((b == "env" || b == "sudo") && w ~ /^[A-Za-z_][A-Za-z0-9_]*=/) continue
      break
    }
    if (b == "timeout" || b == "gtimeout") j++
    j--
  }
  if (j > n) return
  b = base(CW[d, ci, j])
  if (b ~ /^python[23]?(\.[0-9]+)+$/) sub(/(\.[0-9]+)+$/, "", b)
  na = args(d, ci, j + 1, A)
  if (isshell(b)) {
    for (k = 1; k <= na; k++) {
      if (A[k] ~ /^--command=/) { r = A[k]; sub(/^--command=/, "", r); scan(r, d + 1); return }
      if (A[k] == "--command" || A[k] ~ /^-[A-Za-z]*c[A-Za-z]*$/) { for (k++; k <= na; k++) if (A[k] !~ /^-/) { scan(A[k], d + 1); return } return }
      if (A[k] ~ /^-[A-Za-z]*s[A-Za-z]*$/) break
      if (A[k] == "--") { if (k < na) return; break }
      if (A[k] ~ /^[-+][oO]$/) { k++; continue }
      if (A[k] ~ /^[-+]/) continue
      return
    }
    shellstdin(d, ci); return
  }
  if (b == "eval") { r = ""; for (k = 1; k <= na; k++) r = r " " A[k]; scan(r, d + 1); return }
  if (b == "su") { r = after(A, na, "-c"); if (r != "\001") scan(r, d + 1); return }
  if (b == "ssh") {
    for (k = 1; k <= na && A[k] ~ /^-/; k++) if (A[k] ~ /^-[pioFlJLRDWbcEemOQSwB]$/) k++
    if (k >= na) { shellstdin(d, ci); return }
    r = ""; for (k++; k <= na; k++) r = r " " A[k]
    scan(r, d + 1); return
  }
  if (b == "osascript") {
    r = 0; F = 0
    for (k = 1; k <= na; k++) { if (A[k] == "-l" || A[k] == "-s") { k++; continue } F++; A2[F] = A[k] }
    r = inline(A2, F, " -e ", 0)
    if (r == 1) hit(osahit(CODE, d))
    else if (r == 2) hit(osahit(stdintext(d, ci), d))
    return
  }
  F = ""
  if (b ~ /^python[23]?$/) F = " -c "
  else if (b == "node" || b == "bun") F = " -e --eval -p --print "
  else if (b == "perl") F = " -e -E "
  else if (b == "ruby" || b == "lua") F = " -e "
  else if (b == "php") F = " -r "
  else if (b == "pwsh" || b == "powershell") F = " -c -Command -command "
  else if (b == "deno" || b == "swift") F = " "
  if (F != "") {
    r = inline(A, na, F, b == "deno")
    if (r == 1) hit(codehit(CODE, d))
    else if (r == 2) hit(codehit(stdintext(d, ci), d))
    return
  }
  hit(prog(b, A, na))
  if (exec && found == "") for (k = j + 1; k <= n && found == ""; k++) if (CW[d, ci, k] ~ /^-(exec|execdir|ok|okdir)$/) judge(d, ci, k + 1, 0)
}
function flush(d,   ci) { for (ci = 1; ci <= NC[d] && found == ""; ci++) judge(d, ci, 1, 1); NC[d] = 0; newcmd(d, 0) }
function scan(s, d,   n, i, c, q, w, qb, j, nh, HD, HT, HQ, HO, h, rest, m, L, k, t, body, piped) {
  if (d > 8 || found != "" || s == "") return
  n = length(s); q = ""; w = ""; qb = ""; nh = 0; NC[d] = 0; newcmd(d, 0)
  for (i = 1; i <= n && found == ""; i++) {
    if (q == "'") {
      j = index(substr(s, i, 256), "'")
      if (!j) { qb = qb substr(s, i, 256); i += 255; continue }
      qb = qb substr(s, i, j - 1); i += j - 1
      q = ""; w = w qb; continue
    }
    if (q == "\"" && match(substr(s, i, 256), /^[^"\\$\140]+/)) { qb = qb substr(s, i, RLENGTH); i += RLENGTH - 1; continue }
    c = substr(s, i, 1)
    if (q == "\"") {
      if (c == "\\") { i++; qb = qb substr(s, i, 1); continue }
      if (c == "\"") { q = ""; w = w qb; continue }
      if (c == "\140") { j = tick(s, i); scan(substr(s, i + 1, j - i - 1), d + 1); i = j; qb = qb "x"; continue }
      if (c == "$" && substr(s, i + 1, 1) == "(" && substr(s, i + 2, 1) != "(") { j = closer(s, i + 2); scan(substr(s, i + 2, j - i - 2), d + 1); i = j; qb = qb "x"; continue }
      qb = qb c; continue
    }
    if (match(substr(s, i, 256), /^[^ \t;&|()\n'"\\$<#\140]+/)) { w = w substr(s, i, RLENGTH); i += RLENGTH - 1; continue }
    if (c == "\\") { if (i < n) { i++; if (substr(s, i, 1) != "\n") w = w substr(s, i, 1) } continue }
    if (c == "'" || c == "\"") { q = c; qb = ""; continue }
    if (c == "#") { if (w == "") { while (i < n && substr(s, i + 1, 1) != "\n") i++ } else w = w c; continue }
    if (c == "\140") { j = tick(s, i); scan(substr(s, i + 1, j - i - 1), d + 1); i = j; w = w "x"; continue }
    if (c == "$" && substr(s, i + 1, 1) == "'") {
      for (i += 2; i <= n && substr(s, i, 1) != "'"; i++) {
        c = substr(s, i, 1)
        if (c == "\\" && i < n) { c = substr(s, ++i, 1); if (c == "n") c = "\n"; else if (c == "t") c = "\t" }
        w = w c
      }
      continue
    }
    if (c == "$" && substr(s, i + 1, 1) == "{") { j = index(substr(s, i), "}"); if (!j) j = n - i + 1; subs(substr(s, i, j), d + 1); w = w substr(s, i, j); i += j - 1; continue }
    if (c == "$" && substr(s, i + 1, 1) == "(") {
      if (substr(s, i + 2, 1) == "(") { j = closer(s, i + 3); subs(substr(s, i + 3, j - i - 3), d + 1); i = j + 1; w = w "0"; continue }
      j = closer(s, i + 2); scan(substr(s, i + 2, j - i - 2), d + 1); i = j; w = w "x"; continue
    }
    if (c == "<" && substr(s, i, 3) == "<<<") { word(d, w); w = ""; HS[d] = 1; i += 2; continue }
    if (c == "<" && substr(s, i, 2) == "<<") {
      word(d, w); w = ""
      i += 2; nh++; HT[nh] = 0; if (substr(s, i, 1) == "-") { HT[nh] = 1; i++ }
      while (substr(s, i, 1) == " ") i++
      HD[nh] = ""; HQ[nh] = 0; HO[nh] = NC[d]
      while (i <= n && substr(s, i, 1) !~ /[ \t\n;&|<>()]/) { c = substr(s, i, 1); if (c == "'" || c == "\"" || c == "\\") HQ[nh] = 1; else HD[nh] = HD[nh] c; i++ }
      i--; continue
    }
    if (c == "&" && (substr(s, i - 1, 1) ~ /[<>]/ || substr(s, i + 1, 1) == ">")) { w = w c; continue }
    if (c == " " || c == "\t") { word(d, w); w = ""; continue }
    if (c ~ /[;&|()\n]/) {
      word(d, w); w = ""
      piped = c == "|" && substr(s, i + 1, 1) != "|" && substr(s, i - 1, 1) != "|"
      if (c == "\n" && nh > 0) {
        # Each heredoc's body, in order, is the stdin of the command that opened it.
        for (h = 1; h <= nh && found == ""; h++) {
          rest = substr(s, i + 1); m = split(rest, L, "\n"); body = ""
          for (k = 1; k <= m; k++) {
            i += length(L[k]) + 1
            t = L[k]; if (HT[h]) sub(/^[ \t]+/, "", t)
            if (t == HD[h]) break
            body = body L[k] "\n"
          }
          CI[d, HO[h]] = CI[d, HO[h]] body
          if (!HQ[h]) subs(body, d + 1)
        }
        nh = 0
      }
      # A pipe still waiting for its command (a | then a newline) carries on.
      if (c == "\n" && CN[d, NC[d]] == 0 && CI[d, NC[d]] == "" && CP[d, NC[d]]) continue
      if (c == "\n") flush(d)
      else if (CN[d, NC[d]] > 0 || CI[d, NC[d]] != "") newcmd(d, piped)
      else CP[d, NC[d]] = piped
      continue
    }
    w = w c
  }
  word(d, w)
  flush(d)
}
function deny(what) {
  printf "%s", jesc("Walnut refused this command: " ${s(ADVICE_PRE)} what ${s(ADVICE_POST)})
}
BEGIN {
  RS = "\001"
  OK["say"] = "^(-o.*|--output-file.*|--voice=[?])$"; OK["espeak"] = OK["espeak-ng"] = "^(--stdout|-q|-w.*)$"
  OK["aplay"] = "^(-l|-L|--list-devices|--list-pcms)$"; OK["pacat"] = "^(-r|--record)$"
  OK["ffplay"] = "^-an$"
  ON["pw-cat"] = "^(-p|--playback)$"; ON["festival"] = "^--tts$"
}
{
  cmd = jstr($0, "command")
  if (cmd == "") next
  scan(cmd, 0)
  if (found != "") deny(found)
}`


/** Names that may make sound, for the fast bail-out: anything else is allowed unparsed. */
const TRIGGERS = ['say', 'play', 'afplay', 'aplay', 'paplay', 'pacat', 'pw-cat', 'espeak', 'mpv', 'mplayer', 'mpg', 'ogg123', 'vlc', 'sox', 'ffmpeg', 'festival', 'beep', 'speaker-test', 'canberra', 'open', 'volume', 'mute', 'amixer', 'pactl', 'pamixer', 'wpctl', 'osascript', 'Sound', 'Speech', 'sound', 'speech', 'pyttsx3', 'Volume', 'Say', 'Beep', 'Play', 'Audio', 'audio']

/** The awk program as the hook runs it: comment lines and indentation left out. */
export const SOUND_AWK_PROGRAM = SOUND_AWK.replace(/^[ \t]*#.*\n/gm, '').replace(/^[ \t]+/gm, '')

/**
 * The program travels gzipped and in base64 (about 7 KB instead of 18 KB of escaped JSON): every
 * hook script rides each session's settings, which must stay under 100 KB in all
 * (cli-argv-content-ratchet.test.ts). macOS before 13 decodes with -D, every other base64 with -d.
 */
const PACKED = gzipSync(Buffer.from(SOUND_AWK_PROGRAM), { level: 9 }).toString('base64')

/** Too long to parse: refused when any of these names appears as a word at all. */
const LONG_NAMES = [...ALWAYS_PLAYS, 'say', 'espeak', 'espeak-ng', 'aplay', 'pacat', 'pw-cat', 'mpv', 'mplayer', 'ffplay', 'ffmpeg', 'sox', 'festival',
  'osascript', 'amixer', 'pactl', 'pamixer', 'wpctl', 'open', 'xdg-open']

/** The hook command: a fast `case` bail-out, then the awk check. */
export const SOUND_GUARD_COMMAND = [
  '# Walnut sound guard: src/providers/sound-guard-hook.ts (the awk program below is gzip + base64)',
  'in=$(cat 2>/dev/null)',
  `case $in in ${TRIGGERS.map((t) => `*${t}*`).join('|')}) ;; *) exit 0 ;; esac`,
  'if [ ${#in} -gt 100000 ]; then',
  `  printf '%s' "$in" | grep -Eiq '(^|[^A-Za-z0-9_-]|\\\\[nt])(${LONG_NAMES.join('|')})([^A-Za-z0-9_-]|$)|set volume' || exit 0`,
  "  msg='Walnut refused this command: it is too long to check and names a program that can make sound. Make no sound on this machine; write long text with the Write tool.'",
  'else',
  `  b='${PACKED}'`,
  `  p=$( (printf '%s' "$b" | base64 -d 2>/dev/null || printf '%s' "$b" | base64 -D 2>/dev/null) | gzip -dc 2>/dev/null)`,
  `  msg=$(printf '%s' "$in" | awk "$p" 2>/dev/null)`,
  'fi',
  // Only the refusal text refuses: an awk that fails prints nothing, and allows.
  'case $msg in "Walnut refused"*) ;; *) exit 0 ;; esac',
  'printf \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\\n\' "$msg"',
  'exit 0',
].join('\n')

const HOOK_TIMEOUT_SECS = 10

export function soundGuardHooks(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  if (env.WALNUT_SOUND_GUARD === '0') return null
  return {
    PreToolUse: [{
      matcher: 'Bash',
      hooks: [{ type: 'command', command: SOUND_GUARD_COMMAND, timeout: HOOK_TIMEOUT_SECS }],
    }],
  }
}
