/**
 * The PreToolUse hook (matcher `Bash`) that refuses a session's kill by a name
 * pattern: `pkill`, `killall`, or `pgrep` together with `kill` (`pgrep ... |
 * xargs kill`, `kill $(pgrep ...)`), wherever the shell would run it.
 *
 * Why (2026-10-31, twice in 17 minutes): a session stopping its own Playwright
 * run typed `pkill -f "clone.*playwright"`, which SIGTERMed every Claude Code CLI
 * on the Mac, because each one carried hook text naming `git clone` and
 * `playwright-report` in its command line. The same session then wrote a memory
 * note through an UNQUOTED heredoc whose text held that command in backticks;
 * the shell ran it as a command substitution and every session died again. The
 * CLIs no longer carry that text (cli-argv-files-core.ts), but a pattern still
 * matches what another task runs (a test server, a build, a browser), and only
 * the session that started a process knows its pid.
 *
 * What counts as run: a command word (after `;`, `&`, `|`, `(`, a newline, a
 * brace, shell keywords such as `then`/`do`/`!`, and prefixes such as sudo,
 * env, timeout, xargs), the inside of a backtick or `$(...)` (also inside double
 * quotes, a `${...}` and an unquoted heredoc body), the string a shell runs
 * (`bash -c '...'`, `eval '...'`, `ssh host '...'` and `ssh host cmd`), every line
 * of a heredoc fed to a shell or ssh, and any text piped into one (`echo '...' |
 * sh`). `pgrep` counts with `kill` only when its output reaches the kill: the same
 * pipeline (`| xargs kill`), `kill $(pgrep ...)`, or a variable set from it. Text
 * it leaves alone: single-quoted words, a word that only contains the name
 * (`grep pkill`), the body of a quoted heredoc (<<'EOF') fed to anything but a
 * shell, and a pgrep that only reads (`pgrep -fl x; kill 4242`).
 *
 * POSIX sh + awk, like the git guard (git-tmp-guard-hook.ts). A command over
 * 100,000 characters is not parsed: it is refused when it names pkill or killall
 * anywhere. WALNUT_PATTERN_KILL_GUARD=0 on the server turns it off.
 */
import { TMP_PATH_AWK, shQuoteAwk } from './tmp-path-awk.js'

const KILL_AWK = TMP_PATH_AWK + String.raw`
function base(w,   k) { k = w; sub(/^.*\//, "", k); return k }
function isshell(w) { return w ~ /^(ba|z|da|k|c|tc|fi|a)?sh$/ }
function hit(what) { if (found == "") found = what }
# A new simple command; a pipe keeps what the pipeline fed so far (pgrep | xargs kill).
function reset(st, piped) {
  st["cmd"] = ""; st["skip"] = 0; st["eat"] = 0; st["prev"] = ""; st["ssh"] = 0; st["prefix"] = ""
  st["afterpipe"] = piped; if (!piped) st["pgpipe"] = 0
}
# The index of the ")" that closes the "(" before position i, or n + 1: quotes and
# heredoc bodies skipped (an apostrophe in a heredoc opens no quote).
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
# The index of the backtick that ends the one at i, or n + 1.
function tick(s, i,   n) {
  n = length(s)
  for (i++; i <= n; i++) { if (substr(s, i, 1) == "\\") { i++; continue } if (substr(s, i, 1) == "\140") return i }
  return n + 1
}
# Only the command substitutions in s (data text: an unquoted heredoc body, a parameter expansion).
function subs(s, depth,   n, i, c, j) {
  n = length(s)
  for (i = 1; i <= n && found == ""; i++) {
    c = substr(s, i, 1)
    if (c == "\\") { i++; continue }
    if (c == "\140") { j = tick(s, i); scan(substr(s, i + 1, j - i - 1), depth + 1); i = j; continue }
    if (c == "$" && substr(s, i + 1, 1) == "(" && substr(s, i + 2, 1) != "(") { j = closer(s, i + 2); scan(substr(s, i + 2, j - i - 2), depth + 1); i = j }
  }
}
# A command substitution inner of the word w being built: scanned, and when it ran
# pgrep, its output is a kill target (kill $(pgrep x)) or a variable that may become one.
function inner(st, w, text, depth,   before, v) {
  before = pgseen
  scan(text, depth + 1)
  if (pgseen == before) return
  if (st["cmd"] == "kill") hit("kill of pgrep output")
  else if (st["cmd"] == "" && w ~ /^[A-Za-z_][A-Za-z0-9_]*=/) { v = w; sub(/=.*/, "", v); pgvar[v] = 1 }
}
# One finished word of the simple command st describes.
function word(st, w, depth,   b, v) {
  if (w == "") return
  # A brace group opens or closes only as a word of its own ({ cmd; }), never in -I{}.
  if (w == "{" || w == "}") { reset(st, 0); return }
  if (st["eat"]) { st["eat"] = 0; return }
  if (st["cmd"] == "" || st["ssh"] == 2) {
    if (st["ssh"] == 2) reset(st, 0)
    if (w ~ /^[A-Za-z_][A-Za-z0-9_]*=/) return
    if (w ~ /^[0-9]*[<>&]/) return
    # command -v / -V only looks a name up.
    if (st["skip"] && st["prefix"] == "command" && w ~ /^-[vV]$/) { st["cmd"] = "command"; st["skip"] = 0; return }
    if (st["skip"] && w ~ /^-/) { if (w ~ /^-[ugCDnsIPLdEaSkt]$/) st["eat"] = 1; return }
    if (st["skip"] && w ~ /^[0-9.]+[smhd]?$/) return
    b = base(w)
    # Prefixes and shell keywords: the command is the word after them.
    if (b ~ /^(sudo|doas|env|command|exec|nohup|time|nice|ionice|timeout|gtimeout|xargs|builtin|caffeinate|stdbuf|setsid|taskset|chrt|unbuffer|if|then|else|elif|do|while|until|!)$/) { st["skip"] = 1; st["prefix"] = b; return }
    st["cmd"] = b; st["skip"] = 0
    if (st["afterpipe"] && (isshell(b) || b == "ssh")) pipedshell = 1
    if (b == "pkill" || b == "killall") hit(b)
    else if (b == "pgrep") { pgseen++; st["pgpipe"] = 1 }
    else if (b == "kill" && st["pgpipe"]) hit("pgrep piped to kill")
    return
  }
  # ssh host command...: the words after the host are a command of their own.
  if (st["cmd"] == "ssh" && st["ssh"] == 0 && w !~ /^-/ && st["prev"] !~ /^-[pioFlJLRDWbcEemOQSwB]$/) { st["ssh"] = 2; st["prev"] = w; return }
  if (st["cmd"] == "kill") for (v in pgvar) if (index(w, "$" v) || index(w, "$" "{" v)) hit("kill of pgrep output")
  st["prev"] = w
}
# A quoted string just closed: scanned as commands when a shell runs it.
function quoted(st, qb, depth) {
  if (strict || st["ssh"] == 2) { scan(qb, depth + 1); return }
  if (st["cmd"] == "") return
  if ((isshell(st["cmd"]) && st["prev"] ~ /^-[A-Za-z]*c[A-Za-z]*$/) || st["cmd"] == "eval" || st["cmd"] == "su") scan(qb, depth + 1)
}
function scan(s, depth,   n, i, c, q, w, qb, st, j, hd, hdq, hdtab, hdsh, rest, m, L, k, t, piped) {
  if (depth > 8 || found != "") return
  n = length(s); q = ""; w = ""; qb = ""; hd = ""; reset(st, 0)
  for (i = 1; i <= n && found == ""; i++) {
    if (q == "'") {
      # A run to the closing quote, read in bounded windows (linear on a long string).
      j = index(substr(s, i, 256), "'")
      if (!j) { qb = qb substr(s, i, 256); i += 255; continue }
      qb = qb substr(s, i, j - 1); i += j - 1
      q = ""; quoted(st, qb, depth); w = w qb; continue
    }
    if (q == "\"" && match(substr(s, i, 256), /^[^"\\$\140]+/)) { qb = qb substr(s, i, RLENGTH); i += RLENGTH - 1; continue }
    c = substr(s, i, 1)
    if (q == "\"") {
      if (c == "\\") { i++; qb = qb substr(s, i, 1); continue }
      if (c == "\"") { q = ""; quoted(st, qb, depth); w = w qb; continue }
      if (c == "\140") { j = tick(s, i); inner(st, w, substr(s, i + 1, j - i - 1), depth); i = j; qb = qb "x"; continue }
      if (c == "$" && substr(s, i + 1, 1) == "(" && substr(s, i + 2, 1) != "(") { j = closer(s, i + 2); inner(st, w, substr(s, i + 2, j - i - 2), depth); i = j; qb = qb "x"; continue }
      qb = qb c; continue
    }
    if (match(substr(s, i, 256), /^[^ \t;&|()\n'"\\$<#\140]+/)) { w = w substr(s, i, RLENGTH); i += RLENGTH - 1; continue }
    if (c == "\\") { if (i < n) { i++; if (substr(s, i, 1) != "\n") w = w substr(s, i, 1) } continue }
    if (c == "'" || c == "\"") { q = c; qb = ""; continue }
    if (c == "#") { if (w == "") { while (i < n && substr(s, i + 1, 1) != "\n") i++ } else w = w c; continue }
    if (c == "\140") { j = tick(s, i); inner(st, w, substr(s, i + 1, j - i - 1), depth); i = j; w = w "x"; continue }
    if (c == "$" && substr(s, i + 1, 1) == "{") { j = index(substr(s, i), "}"); if (!j) j = n - i + 1; subs(substr(s, i, j), depth + 1); w = w substr(s, i, j); i += j - 1; continue }
    if (c == "$" && substr(s, i + 1, 1) == "(") {
      if (substr(s, i + 2, 1) == "(") { j = closer(s, i + 3); i = j + 1; w = w "0"; continue }
      j = closer(s, i + 2); inner(st, w, substr(s, i + 2, j - i - 2), depth); i = j; w = w "x"; continue
    }
    if (c == "<" && substr(s, i, 3) == "<<<") { word(st, w, depth); w = ""; i += 2; continue }
    if (c == "<" && substr(s, i, 2) == "<<") {
      word(st, w, depth); w = ""
      hdsh = isshell(st["cmd"]) || st["cmd"] == "ssh" || st["cmd"] == "eval"
      i += 2; hdtab = 0; if (substr(s, i, 1) == "-") { hdtab = 1; i++ }
      while (substr(s, i, 1) == " ") i++
      hd = ""; hdq = 0
      while (i <= n && substr(s, i, 1) !~ /[ \t\n;&|<>()]/) { c = substr(s, i, 1); if (c == "'" || c == "\"" || c == "\\") hdq = 1; else hd = hd c; i++ }
      i--; continue
    }
    # A redirection's & (2>&1, &>file) is part of its word.
    if (c == "&" && (substr(s, i - 1, 1) ~ /[<>]/ || substr(s, i + 1, 1) == ">")) { w = w c; continue }
    if (c == " " || c == "\t") { word(st, w, depth); w = ""; continue }
    if (c ~ /[;&|()\n]/) {
      word(st, w, depth); w = ""
      piped = c == "|" && substr(s, i + 1, 1) != "|" && substr(s, i - 1, 1) != "|"
      reset(st, piped)
      if (c == "\n" && hd != "") {
        rest = substr(s, i + 1); m = split(rest, L, "\n")
        for (k = 1; k <= m && found == ""; k++) {
          i += length(L[k]) + 1
          t = L[k]; if (hdtab) sub(/^[ \t]+/, "", t)
          if (t == hd) break
          if (hdsh || strict) scan(L[k], depth + 1)
          else if (!hdq) subs(L[k], depth + 1)
        }
        hd = ""
      }
      continue
    }
    w = w c
  }
  word(st, w, depth)
}
function deny(what) {
  printf "%s", jesc("Walnut refused this command: it kills processes by a name pattern (" what "). A pattern also matches processes that are not yours: other sessions, their test servers and builds (on 2026-10-31 one pkill -f stopped every Claude Code session on the Mac). " \
    "Stop only what you started: a background task with its own stop tool, or kill <pid> (kill -- -<pgid> for its group) with the pid you recorded when you started it ($! after a background start, or lsof -tiTCP:<port> -sTCP:LISTEN for a server on your own port). " \
    "If the words are only text you are writing, write it with the Write tool or a quoted heredoc (<<'EOF'), where the shell runs nothing.")
}
BEGIN { RS = "\001" }
{
  cmd = jstr($0, "command")
  if (cmd == "") next
  scan(cmd, 0)
  # Text piped into a shell (echo '...' | sh, cat <<EOF | bash) is run too: look again, reading every string as commands.
  if (found == "" && pipedshell) { strict = 1; scan(cmd, 0) }
  if (found != "") deny(found)
}`

/** The hook command: a fast `case` bail-out, then the awk check. */
export const PATTERN_KILL_GUARD_COMMAND = [
  'in=$(cat 2>/dev/null)',
  'case $in in *pkill*|*killall*|*pgrep*) ;; *) exit 0 ;; esac',
  // Too long to parse quickly: refuse only when pkill or killall is named at all.
  'if [ ${#in} -gt 100000 ]; then',
  // A JSON escape before the name (\n, \t) is a boundary too.
  "  printf '%s' \"$in\" | grep -Eq '(^|[^A-Za-z0-9_-]|\\\\[nt])(pkill|killall)([^A-Za-z0-9_-]|$)' || exit 0",
  "  msg='Walnut refused this command: it is too long to check and names pkill or killall. Stop only what you started, by the pid you recorded; write long text with the Write tool.'",
  'else',
  // Comment lines stay in the source: the hook text rides every session's settings.
  `  msg=$(printf '%s' "$in" | awk ${shQuoteAwk(KILL_AWK.replace(/^[ \t]*#.*\n/gm, ''))} 2>/dev/null)`,
  'fi',
  // Only the refusal text refuses: an awk that fails prints nothing, and allows.
  'case $msg in "Walnut refused"*) ;; *) exit 0 ;; esac',
  'printf \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\\n\' "$msg"',
  'exit 0',
].join('\n')

const HOOK_TIMEOUT_SECS = 10

export function patternSignalGuardHooks(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  if (env.WALNUT_PATTERN_KILL_GUARD === '0') return null
  return {
    PreToolUse: [{
      matcher: 'Bash',
      hooks: [{ type: 'command', command: PATTERN_KILL_GUARD_COMMAND, timeout: HOOK_TIMEOUT_SECS }],
    }],
  }
}
