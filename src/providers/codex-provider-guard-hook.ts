/**
 * The PreToolUse hook (matcher `Bash`) that refuses a session's Codex model run
 * that names no model provider: `codex exec`, `codex review`, `codex resume`, a
 * bare `codex` or `codex "<prompt>"`, wherever the shell would run it, unless
 * that invocation passes `-c model_provider=<name>` (or `--config`,
 * `-cmodel_provider=`, `--config=model_provider=`) after its subcommand.
 *
 * Why: a reviewer run of `codex exec` with no provider override used the
 * account's default provider and spent a large token budget. The user routes
 * every Codex run through a provider they configured, so a session must name it
 * on each run, and the right place is after the subcommand (`codex exec -c
 * model_provider=<name> ...`), where it plainly belongs to that run.
 *
 * What counts as run is read the way the pattern kill guard reads it
 * (pattern-kill-guard-hook.ts, whose scanner this follows): a command word
 * (after `;`, `&`, `|`, `(`, a newline, a brace, shell keywords, and prefixes
 * such as sudo, env, command, timeout, xargs, watch, npx, `npm exec`, `bun x`,
 * `find -exec`), any path whose last part is codex (`/opt/x/bin/codex`,
 * `@openai/codex@latest`), the inside of a backtick or `$(...)`, the string a
 * shell runs (`bash -c '...'`, `bash <<< '...'`, `eval`, `env -S`, `ssh host
 * ...`), every line of a heredoc fed to a shell, and text piped into a shell or
 * ssh that reads its script from stdin. Text it leaves alone: a word that only
 * names codex (`grep codex`, `which codex`, `src/codex-session.ts`, a case
 * pattern, an array literal, a function name), a quoted argument of another
 * command, a heredoc body fed to anything but a shell. Subcommands that start no
 * model run pass (`login`, `logout`, `mcp`, `completion`, `features`, `help`,
 * `sandbox`, `apply`, `cloud` without `exec`, and any other single lowercase
 * word, so a newer subcommand is not refused), and so does any invocation asking
 * for `--help` or `--version`. Not followed: a command started inside another
 * program (tmux, docker exec, script) or named through a variable.
 *
 * POSIX sh + awk (BSD awk, gawk, mawk, busybox). A command over 100,000
 * characters is not parsed: it is refused when it names `codex exec`, `review`
 * or `resume` (options between allowed) and never says `model_provider`. Input that is not a well formed hook
 * payload is never refused. WALNUT_CODEX_PROVIDER_GUARD=0 on the server turns
 * it off.
 */
import { TMP_PATH_AWK, shQuoteAwk } from './tmp-path-awk.js'

const CODEX_AWK = TMP_PATH_AWK + String.raw`
function base(w,   k) { k = w; sub(/^.*\//, "", k); return k }
function isshell(w) { return w ~ /^(ba|z|da|k|c|tc|fi|a)?sh$/ }
function hit(what) { if (found == "") found = what }
# A value that selects a provider: model_provider=<something>, quotes and spaces aside.
function prov(v) { if (!sub(/^[ \t]*model_provider[ \t]*=[ \t]*/, "", v)) return 0; gsub(/["' \t]/, "", v); return v != "" }
function mark(st) { if (st["cxsub"] == "") st["cxpre"] = 1; else st["cxok"] = 1 }
# The codex invocation the simple command st holds ended: refuse a model run with no provider after its subcommand.
function judge(st,   sub_) {
  if (!st["cx"]) return
  sub_ = st["cxsub"]
  if (sub_ == "cloud") return
  if (sub_ == "" || sub_ == "prompt") { if (!st["cxpre"] && !st["cxok"]) hit(sub_ == "" ? "a bare codex" : "codex with a prompt") }
  else if (!st["cxok"]) hit("codex " sub_ (st["cxpre"] ? ", whose -c model_provider comes before the subcommand" : ""))
}
# A new simple command (the one before it is judged first, and what an eval of it runs is read).
function reset(st, piped,   t, d) {
  judge(st)
  # A shell or ssh after a pipe that reads its script from stdin: the text fed to it is run.
  if (st["pipesh"]) pipedshell = 1
  t = st["ev"]; d = st["evd"]
  st["cmd"] = ""; st["skip"] = 0; st["eat"] = 0; st["prev"] = ""; st["ssh"] = 0; st["prefix"] = ""
  st["pipesh"] = 0; st["shs"] = 0; st["herestr"] = 0; st["envs"] = 0; st["ev"] = ""
  st["cx"] = 0; st["cxsub"] = ""; st["cxok"] = 0; st["cxpre"] = 0; st["cxval"] = 0; st["cxredir"] = 0; st["cxdd"] = 0; st["cxn"] = 0
  st["afterpipe"] = piped
  if (t != "") scan(t, d + 1)
}
# Options of a prefix that take the next word as their value.
function takesval(p, w) {
  if (p == "sudo" || p == "doas") return w ~ /^-[ugCDhprtUTR]$/
  if (p == "env") return w ~ /^-[uCP]$/
  if (p == "timeout" || p == "gtimeout") return w ~ /^-[sk]$/
  if (p == "xargs") return w ~ /^-[nsILdEPaJR]$/
  if (p == "nice" || p == "watch") return w == "-n"
  if (p == "ionice") return w ~ /^-[cnp]$/
  if (p == "stdbuf") return w ~ /^-[ioe]$/
  if (p == "npx" || p == "bunx" || p == "pnpx") return w == "-p" || w == "--package"
  return 0
}
# One word after codex.
function cxarg(st, w,   v) {
  if (st["cxredir"]) { st["cxredir"] = 0; return }
  if (st["cxdd"]) return
  if (st["cxval"]) { st["cxval"] = 0; if (st["cxvalc"] && prov(w)) mark(st); return }
  st["cxn"]++
  # Help and version print and exit: no model run.
  if (w ~ /^(-h|--help|-V|--version)$/) { st["cx"] = 0; return }
  # After -- every word is a positional (prompt text), never an override.
  if (w == "--") { st["cxdd"] = 1; return }
  if (w ~ /^[0-9]*(<|>|>>|<>|&>|>&|>\|)$/) { st["cxredir"] = 1; return }
  if (w ~ /^[0-9]*[<>&]/) return
  if (w == "-c" || w == "--config") { st["cxval"] = 1; st["cxvalc"] = 1; return }
  if (w ~ /^--config=/) { if (prov(substr(w, 10))) mark(st); return }
  if (w ~ /^-c[^ \t]/) { v = substr(w, 3); sub(/^=/, "", v); if (prov(v)) mark(st); return }
  if (w ~ /^-/) {
    # An option before the subcommand that takes a value: that value is no subcommand.
    if (st["cxsub"] == "" && w ~ /^(-m|--model|-p|--profile|-i|--image|-s|--sandbox|-a|--ask-for-approval|-C|--cd|--add-dir|--enable|--disable|--local-provider)$/) { st["cxval"] = 1; st["cxvalc"] = 0 }
    return
  }
  # codex cloud browses tasks; codex cloud exec starts one.
  if (st["cxsub"] == "cloud") { if (w == "exec") st["cxsub"] = "cloud exec"; else st["cx"] = 0; return }
  if (st["cxsub"] != "") return
  if (w ~ /^(exec|e|review|resume|fork|cloud|app-server|mcp-server|proto)$/) st["cxsub"] = w
  # Any other single lowercase word is a subcommand that starts no model run (login, mcp, completion,
  # features, sandbox, apply, or a newer one): a prompt is text, not one bare word.
  else if (w ~ /^[a-z][a-z0-9-]*$/) st["cx"] = 0
  else st["cxsub"] = "prompt"
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
# One finished word of the simple command st describes.
function word(st, w, depth,   b) {
  if (w == "") return
  # A brace group opens or closes only as a word of its own ({ cmd; }).
  if (w == "{" || w == "}") { reset(st, 0); return }
  # The word after <<< is a shell's script, or data for anything else.
  if (st["herestr"]) { st["herestr"] = 0; if (st["herestrsh"]) scan(w, depth + 1); return }
  if (st["eat"]) { st["eat"] = 0; return }
  # env -S 'cmd args': the string is the command.
  if (st["envs"]) { st["envs"] = 0; scan(w, depth + 1); st["cmd"] = "env"; st["skip"] = 0; return }
  if (st["cx"]) { cxarg(st, w); return }
  if (st["cmd"] == "" || st["ssh"] == 2) {
    if (st["ssh"] == 2) { st["pipesh"] = 0; reset(st, 0) }
    if (w ~ /^[A-Za-z_][A-Za-z0-9_]*=/) return
    if (w ~ /^[0-9]*[<>&]/) return
    # command -v / -V only looks a name up.
    if (st["skip"] && st["prefix"] == "command" && w ~ /^-[vV]$/) { st["cmd"] = "command"; st["skip"] = 0; return }
    if (st["skip"] && st["prefix"] == "env" && w ~ /^(-S|--split-string)$/) { st["envs"] = 1; return }
    if (st["skip"] && st["prefix"] == "env" && w ~ /^-S./) { scan(substr(w, 3), depth + 1); st["cmd"] = "env"; st["skip"] = 0; return }
    if (st["skip"] && w ~ /^-/) { if (takesval(st["prefix"], w)) st["eat"] = 1; return }
    if (st["skip"] && w ~ /^[0-9.]+[smhd]?$/) return
    b = base(w)
    # Prefixes and shell keywords: the command is the word after them.
    if (b ~ /^(sudo|doas|env|command|exec|nohup|time|nice|ionice|timeout|gtimeout|xargs|builtin|caffeinate|stdbuf|setsid|taskset|chrt|unbuffer|npx|bunx|pnpx|watch|arch|if|then|else|elif|do|while|until|!)$/) { st["skip"] = 1; st["prefix"] = b; return }
    st["cmd"] = b; st["skip"] = 0
    st["pipesh"] = st["afterpipe"] && (isshell(b) || b == "ssh")
    if (b ~ /^codex(@.*)?$/) st["cx"] = 1
    return
  }
  # A piped shell given -c or a script file reads no script from stdin (-s keeps it reading).
  if (st["pipesh"] && isshell(st["cmd"])) { if (w ~ /^-[A-Za-z]*s/) st["shs"] = 1; else if (!st["shs"] && (w ~ /^-[A-Za-z]*c/ || w !~ /^-/)) st["pipesh"] = 0 }
  # eval runs its words joined: read them as a command when this one ends.
  if (st["cmd"] == "eval") { st["ev"] = st["ev"] " " w; st["evd"] = depth; return }
  # find -exec cmd ... ;, npm exec / pnpm dlx / bun x cmd: the words after are a command.
  if (st["cmd"] == "find" && w ~ /^-(exec|execdir|ok|okdir)$/) { st["cmd"] = ""; st["skip"] = 0; return }
  if (st["cmd"] ~ /^(npm|pnpm|yarn|bun)$/ && st["prev"] == "" && w ~ /^(exec|dlx|x)$/) { st["cmd"] = ""; st["skip"] = 1; st["prefix"] = "npx"; return }
  # ssh host command...: the words after the host are a command of their own.
  if (st["cmd"] == "ssh" && st["ssh"] == 0 && w !~ /^-/ && st["prev"] !~ /^-[pioFlJLRDWbcEemOQSwB]$/) { st["ssh"] = 2; st["prev"] = w; return }
  st["prev"] = w
}
# A quoted string just closed: scanned as commands when a shell runs it.
function quoted(st, qb, depth) {
  if (strict || st["ssh"] == 2) { scan(qb, depth + 1); return }
  if (st["cmd"] == "" || st["cx"]) return
  if ((isshell(st["cmd"]) && st["prev"] ~ /^-[A-Za-z]*c[A-Za-z]*$/) || st["cmd"] == "su") scan(qb, depth + 1)
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
      if (c == "\140") { j = tick(s, i); scan(substr(s, i + 1, j - i - 1), depth + 1); i = j; qb = qb "x"; continue }
      if (c == "$" && substr(s, i + 1, 1) == "(" && substr(s, i + 2, 1) != "(") { j = closer(s, i + 2); scan(substr(s, i + 2, j - i - 2), depth + 1); i = j; qb = qb "x"; continue }
      qb = qb c; continue
    }
    if (match(substr(s, i, 256), /^[^ \t;&|()\n'"\\$<#\140]+/)) { w = w substr(s, i, RLENGTH); i += RLENGTH - 1; continue }
    if (c == "\\") { if (i < n) { i++; if (substr(s, i, 1) != "\n") w = w substr(s, i, 1) } continue }
    if (c == "'" || c == "\"") { q = c; qb = ""; continue }
    if (c == "#") { if (w == "") { while (i < n && substr(s, i + 1, 1) != "\n") i++ } else w = w c; continue }
    if (c == "\140") { j = tick(s, i); scan(substr(s, i + 1, j - i - 1), depth + 1); i = j; w = w "x"; continue }
    if (c == "$" && substr(s, i + 1, 1) == "{") { j = index(substr(s, i), "}"); if (!j) j = n - i + 1; subs(substr(s, i, j), depth + 1); w = w substr(s, i, j); i += j - 1; continue }
    if (c == "$" && substr(s, i + 1, 1) == "(") {
      if (substr(s, i + 2, 1) == "(") { j = closer(s, i + 3); i = j + 1; w = w "0"; continue }
      j = closer(s, i + 2); scan(substr(s, i + 2, j - i - 2), depth + 1); i = j; w = w "x"; continue
    }
    if (c == "<" && substr(s, i, 3) == "<<<") { word(st, w, depth); w = ""; i += 2; st["herestr"] = 1; st["herestrsh"] = isshell(st["cmd"]) || st["cmd"] == "eval"; continue }
    # An array literal (a=(x y)) is data.
    if (c == "(" && w ~ /^[A-Za-z_][A-Za-z0-9_]*[+]?=$/) { j = closer(s, i + 1); w = w substr(s, i, j - i + 1); i = j; continue }
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
      # A lone codex word before ( ) or | is a name (a function, a case pattern), not a run.
      if (st["cx"] && st["cxn"] == 0 && (c == "(" || c == ")" || piped)) st["cx"] = 0
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
  reset(st, 0)
}
function deny(what) {
  printf "%s", jesc("Walnut refused this command: it starts a Codex model run (" what ") with no model provider override after the subcommand, so it would use the account default provider. " \
    "Walnut sessions must name the provider on every Codex run, after the subcommand: codex exec -c model_provider=<your provider> ... (the same for codex review). " \
    "Better still, run the work as a Walnut task on the Codex engine. " \
    "WALNUT_CODEX_PROVIDER_GUARD=0 on the Walnut server turns this check off; that is for a person to decide, not a way around it.")
}
BEGIN { RS = "\001" }
{
  # Only a well formed payload: the command string closes, and the object does.
  if (!match($0, /"command"[ \t]*:[ \t]*"([^"\\]|\\.)*"/) || $0 !~ /[}][ \t\r\n]*$/) next
  cmd = jstr($0, "command")
  if (cmd == "") next
  scan(cmd, 0)
  # Text piped into a shell (echo '...' | sh, cat <<EOF | bash) is run too: look again, reading every string as commands.
  if (found == "" && pipedshell) { strict = 1; scan(cmd, 0) }
  if (found != "") deny(found)
}`

/** The hook command: a fast `case` bail-out, then the awk check. */
export const CODEX_PROVIDER_GUARD_COMMAND = [
  'in=$(cat 2>/dev/null)',
  'case $in in *codex*) ;; *) exit 0 ;; esac',
  // Too long to parse quickly: refuse only a codex exec or review with no provider named anywhere.
  'if [ ${#in} -gt 100000 ]; then',
  "  printf '%s' \"$in\" | grep -Eq '(^|[^A-Za-z0-9_.-]|\\\\[nt])codex(@[^ ]*)?(( |\\\\[nt])+-[^ ]+)*( |\\\\[nt])+(exec|e|review|resume)([^A-Za-z0-9_-]|$)' || exit 0",
  "  printf '%s' \"$in\" | grep -q 'model_provider' && exit 0",
  "  msg='Walnut refused this command: it is too long to check and runs codex exec or codex review with no model provider. Pass -c model_provider=<your provider> after the subcommand; write long text with the Write tool.'",
  'else',
  // Comment lines stay in the source: the hook text rides every session's settings.
  `  msg=$(printf '%s' "$in" | awk ${shQuoteAwk(CODEX_AWK.replace(/^[ \t]*#.*\n/gm, ''))} 2>/dev/null)`,
  'fi',
  // Only the refusal text refuses: an awk that fails prints nothing, and allows.
  'case $msg in "Walnut refused"*) ;; *) exit 0 ;; esac',
  'printf \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\\n\' "$msg"',
  'exit 0',
].join('\n')

const HOOK_TIMEOUT_SECS = 10

export function codexProviderGuardHooks(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  if (env.WALNUT_CODEX_PROVIDER_GUARD === '0') return null
  return {
    PreToolUse: [{
      matcher: 'Bash',
      hooks: [{ type: 'command', command: CODEX_PROVIDER_GUARD_COMMAND, timeout: HOOK_TIMEOUT_SECS }],
    }],
  }
}
