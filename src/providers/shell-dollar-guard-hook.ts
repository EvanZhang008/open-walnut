/**
 * The PreToolUse hook (matcher `Bash`) that refuses a `walnut` call whose text the
 * shell would change before Walnut sees it: a `$` and a digit inside double quotes,
 * unquoted, or in a heredoc whose delimiter is not quoted.
 *
 * Why (2026-10-30): a lead passed its reply to `walnut tools call` with the JSON in
 * double quotes, and the shell expanded "$14" and "$52" as positional parameters, so
 * Main read "$14.99" as ".99" (zsh) and bash would have made it "4.99" ("$1" then "4").
 * Nothing reported it. The CLI also checks the text it parsed
 * (tool-args-source.ts strippedShellText), but only zsh leaves a shape it can see;
 * the command the session typed is the one place every shell's damage is still visible.
 *
 * It reads only that command, and only one that runs `walnut` (a path such as
 * `open-walnut/` or a tool such as `walnut-dev` is not that); a `${1}` the session
 * wrote braced is taken as meant. Rare forms it may refuse though the shell would not
 * expand them: ANSI-C quotes (`$'...'`), a `$1` inside `$(...)` single quotes, `$((1 << 2))`. POSIX sh + awk, like the git guard
 * (git-tmp-guard-hook.ts). WALNUT_SHELL_DOLLAR_GUARD=0 on the server turns it off.
 */
import { TMP_PATH_AWK, shQuoteAwk } from './tmp-path-awk.js'

const DOLLAR_AWK = TMP_PATH_AWK + String.raw`
function hit(s) {
  found = s
  printf "%s", jesc("Walnut refused this command: the shell would expand " s " before walnut reads it, so a text like \"$14.99\" arrives as \".99\" or \"4.99\" and nobody is told. " \
    "Put the JSON in single quotes, or send it on stdin from a quoted heredoc (walnut tools call <op> - <<'EOF' ... EOF), which the shell leaves alone. " \
    "A positional parameter you mean to expand is written braced, as $" "{1}.")
}
BEGIN { RS = "\001" }
{
  cmd = jstr($0, "command")
  # The walnut command itself, not a path or a name that only contains the word (open-walnut, walnut-dev).
  if (length(cmd) > 100000 || (" " cmd " ") !~ /[^A-Za-z0-9_.-]walnut[^A-Za-z0-9_.-]/) next
  n = length(cmd); q = ""; hd = ""; hdq = 0; hdtab = 0; prev = " "
  for (i = 1; i <= n && found == ""; i++) {
    c = substr(cmd, i, 1)
    if (q == "'") { if (c == "'") q = ""; prev = c; continue }
    if (c == "\\" && i < n) { i++; prev = "x"; continue }
    if (c == "$" && substr(cmd, i + 1, 1) ~ /[0-9]/) { hit(substr(cmd, i, 2)); break }
    if (q == "\"") { if (c == "\"") q = ""; prev = c; continue }
    # A comment runs to the end of its line (an apostrophe in it opens no quote).
    if (c == "#" && prev ~ /[ \t\n;&|(]/) { while (i < n && substr(cmd, i + 1, 1) != "\n") i++; prev = " "; continue }
    prev = c
    if (c == "'" || c == "\"") { q = c; continue }
    # A here-string (<<<) is a word, quoted like any other.
    if (substr(cmd, i, 3) == "<<<") { i += 2; continue }
    if (c == "<" && substr(cmd, i, 2) == "<<") {
      i += 2; hdtab = 0; if (substr(cmd, i, 1) == "-") { hdtab = 1; i++ }
      while (substr(cmd, i, 1) == " ") i++
      hd = ""; hdq = 0
      while (i <= n && substr(cmd, i, 1) !~ /[ \t\n;&|<>()]/) { c = substr(cmd, i, 1); if (c == "'" || c == "\"" || c == "\\") hdq = 1; else hd = hd c; i++ }
      i--; continue
    }
    if (c == "\n" && hd != "") {
      # The body: data the shell expands only when the delimiter is unquoted.
      rest = substr(cmd, i + 1)
      while (rest != "") {
        nl = index(rest, "\n"); line = nl ? substr(rest, 1, nl - 1) : rest
        i += (nl ? nl : length(rest))
        # <<- drops leading tabs (the hook's JSON read turns a tab into a space).
        t = line; if (hdtab) sub(/^[ \t]+/, "", t)
        if (t == hd) break
        if (!hdq) {
          gsub(/\\\\/, "", line); gsub(/\\\$/, "", line)
          if (match(line, /\$[0-9]/)) { hit(substr(line, RSTART, 2)); break }
        }
        rest = nl ? substr(rest, nl + 1) : ""
      }
      hd = ""; prev = " "; continue
    }
  }
}`

/** The hook command: a fast `case` bail-out, then the awk check. */
export const SHELL_DOLLAR_GUARD_COMMAND = [
  'in=$(cat 2>/dev/null)',
  "case $in in *walnut*) ;; *) exit 0 ;; esac",
  "case $in in *'$'[0-9]*) ;; *) exit 0 ;; esac",
  '[ ${#in} -le 100000 ] || exit 0',
  `msg=$(printf '%s' "$in" | awk ${shQuoteAwk(DOLLAR_AWK)} 2>/dev/null)`,
  'case $msg in "Walnut refused"*) ;; *) exit 0 ;; esac',
  'printf \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\\n\' "$msg"',
  'exit 0',
].join('\n')

const HOOK_TIMEOUT_SECS = 10

export function shellDollarGuardHooks(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  if (env.WALNUT_SHELL_DOLLAR_GUARD === '0') return null
  return {
    PreToolUse: [{
      matcher: 'Bash',
      hooks: [{ type: 'command', command: SHELL_DOLLAR_GUARD_COMMAND, timeout: HOOK_TIMEOUT_SECS }],
    }],
  }
}
