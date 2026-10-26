/**
 * The PreToolUse hook (matcher `Bash`) that refuses a session's own `git clone`
 * or `git worktree add` into a temp directory, and a `git commit` in a repo
 * that lives in one, and points the session at its task directory instead
 * (src/lib/task-dir.ts explains the directory).
 *
 * Why (2026-10-25): a Mac restart emptied /tmp, and with it several tasks'
 * working clones, one task's only copy of an unmerged commit, and evidence
 * other tasks had kept there. /tmp is wiped at boot and swept by cleaners
 * between boots; nothing that holds unmerged work belongs in it.
 *
 * Why a hook on the command the session typed, not a `git` wrapper on PATH:
 * a wrapper also sees every script and test the session runs, and plenty of
 * those clone into a fresh temp dir and throw it away (a deploy's clean
 * clone, a test fixture repo). Those are disposable by design; the loss came
 * from the agent choosing /tmp for its own work, which is exactly the command
 * it types. The hook reads only that command.
 *
 * The check is POSIX sh + awk (macOS, glibc and busybox hosts all have both;
 * a remote host may have no node), and it costs one `case` on a command that
 * names neither `clone`, `worktree` nor `commit`. It refuses with a PreToolUse
 * `deny` decision on stdout, whose reason the CLI hands to the model; that holds
 * in every permission mode, bypass included (verified on CLI 2.1.284).
 * It follows a variable the same command set (`d=/tmp/x`, `d=$(mktemp -d)`:
 * a live session's first way around it, 2026-10-26, was `cd "$d"` after a
 * mktemp) and never refuses what it cannot resolve: any other `$(...)` or an
 * unknown variable passes. A clone FROM a temp path into a temp path passes
 * too (a scratch copy of scratch has nothing to lose).
 *
 * WALNUT_TMP_GIT_GUARD=0 on the server turns it off. With no WALNUT_TASK_DIR
 * in the session's env (an older daemon), it allows everything.
 */

const GUARD_AWK = String.raw`
function jstr(s, key,   i, c, out, n) {
  if (!match(s, "\"" key "\"[ \t]*:[ \t]*\"")) return ""
  s = substr(s, RSTART + RLENGTH); out = ""; n = length(s)
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    if (c == "\\") {
      i++; c = substr(s, i, 1)
      if (c == "n") c = "\n"
      else if (c == "t" || c == "r") c = " "
      else if (c == "u") { i += 4; c = " " }
      out = out c; continue
    }
    if (c == "\"") break
    out = out c
  }
  return out
}
function strip(p) { while (length(p) > 1 && substr(p, length(p)) == "/") p = substr(p, 1, length(p) - 1); return p }
function expand(t,   vn) {
  if (t == "~") t = HOME
  else if (substr(t, 1, 2) == "~/") t = HOME substr(t, 2)
  gsub(/\$\{HOME\}|\$HOME/, HOME, t)
  if (TMPD != "") gsub(/\$\{TMPDIR\}|\$TMPDIR/, TMPD, t)
  if (TD != "") gsub(/\$\{WALNUT_TASK_DIR\}|\$WALNUT_TASK_DIR/, TD, t)
  for (vn in vars) t = subvar(t, vn, vars[vn])
  return t
}
# Replace \${name} and $name (not a longer name) with val.
function subvar(t, name, val,   out, k, rest, nx) {
  out = ""; rest = t
  while ((k = index(rest, "$")) > 0) {
    out = out substr(rest, 1, k - 1); rest = substr(rest, k)
    if (substr(rest, 1, length(name) + 3) == "$" "{" name "}") { out = out val; rest = substr(rest, length(name) + 4); continue }
    nx = substr(rest, length(name) + 2, 1)
    if (substr(rest, 2, length(name)) == name && nx !~ /[A-Za-z0-9_]/) { out = out val; rest = substr(rest, length(name) + 2); continue }
    out = out "$"; rest = substr(rest, 2)
  }
  return out rest
}
# The directory a $(mktemp ...) makes: the template's, -p/--tmpdir's, else the temp dir.
function mktemp_path(v,   w, nw, i, dir, tpl, tflag, root) {
  if (substr(v, 1, 2) == "$(") v = substr(v, 3); else v = substr(v, 2)
  while (v != "" && (substr(v, length(v)) == ")" || substr(v, length(v)) == BT)) v = substr(v, 1, length(v) - 1)
  gsub(/["']/, "", v)
  nw = split(v, w, /[ \t]+/); dir = ""; tpl = ""; tflag = 0
  for (i = 2; i <= nw; i++) {
    if (w[i] == "-p" || w[i] == "--tmpdir") { dir = w[++i]; continue }
    if (w[i] ~ /^--tmpdir=/) { dir = substr(w[i], 10); continue }
    if (w[i] ~ /^-p./) { dir = substr(w[i], 3); continue }
    if (w[i] == "-t") { tflag = 1; continue }
    if (substr(w[i], 1, 1) == "-") continue
    if (w[i] != "") tpl = w[i]
  }
  root = TMPD != "" ? norm(TMPD) : "/tmp"
  if (dir != "") { dir = resolve(CWD, dir); return dir == "" ? "" : dir "/mktemp" }
  if (tpl != "" && !tflag) return resolve(CWD, tpl)
  return root "/mktemp"
}
function is_mktemp(t,   c) {
  if (substr(t, 1, 8) == "$(mktemp") c = substr(t, 9, 1); else if (substr(t, 1, 7) == BT "mktemp") c = substr(t, 8, 1); else return 0
  return c == "" || c == " " || c == "\t" || c == ")" || c == BT
}
function norm(p,   parts, n, i, out, k, stack) {
  n = split(p, parts, "/"); k = 0
  for (i = 1; i <= n; i++) {
    if (parts[i] == "" || parts[i] == ".") continue
    if (parts[i] == "..") { if (k > 0) k--; continue }
    stack[++k] = parts[i]
  }
  out = ""
  for (i = 1; i <= k; i++) out = out "/" stack[i]
  return out == "" ? "/" : out
}
# "" when the path cannot be known (command substitution, another variable).
function resolve(base, t) {
  if (is_mktemp(t)) return mktemp_path(t)
  t = expand(t)
  if (t == "" || index(t, "$") || index(t, "\140")) return ""
  if (substr(t, 1, 1) != "/") { if (base == "") return ""; t = base "/" t }
  return norm(t)
}
# macOS /var and /tmp are /private/var and /private/tmp: compare without the prefix.
function canon(p) { if (p ~ /^\/private\/(var|tmp)(\/|$)/) p = substr(p, 9); return p }
function under(p, root) { p = canon(p); root = canon(strip(root)); return root != "" && (p == root || substr(p, 1, length(root) + 1) == root "/") }
function volatile(p) {
  if (p == "" || (TD != "" && under(p, TD))) return 0
  return under(p, "/tmp") || under(p, "/var/folders") || (TMPD != "" && under(p, norm(TMPD)))
}
# JSON string escape by hand: awks disagree on backslashes in a gsub replacement.
function jesc(s,   i, c, out) {
  out = ""
  for (i = 1; i <= length(s); i++) {
    c = substr(s, i, 1)
    if (c == "\\" || c == "\"") out = out "\\" c
    else if (c == "\n" || c == "\t" || c == "\r") out = out " "
    else out = out c
  }
  return out
}
function deny(what, p) {
  printf "%s", jesc("Walnut refused this command: it puts " what " " p ". Temp directories are emptied at every reboot and swept by cleaners, so a clone, worktree or commit there can be lost. " \
    "Put it in your task directory, which survives reboots and is cleaned by Walnut after the task completes: " TD " (for example " TD "/<repo>). " \
    "Only disposable files (screenshots, scratch output, rebuildable builds) belong in /tmp.")
  denied = 1
}
# Values of these options are separate words; skipping them finds the positionals.
function takes_value(sub_, o) {
  if (sub_ == "clone") return o ~ /^(-b|--branch|-o|--origin|-c|--config|--depth|--reference|--reference-if-able|-u|--upload-pack|--template|--separate-git-dir|-j|--jobs|--filter|--shallow-since|--shallow-exclude|--server-option|--bundle-uri|--ref-format)$/
  if (sub_ == "worktree") return o ~ /^(-b|-B|--reason)$/
  return 0
}
function check(   j, k, g, sub_, pos, np, dest, src, base, d) {
  if (nt == 0) return
  j = 1
  while (j <= nt && (tok[j] ~ /^[A-Za-z_][A-Za-z0-9_]*=/ || tok[j] ~ /^(command|exec|time|nohup|nice|sudo|env|export|local|readonly)$/)) j++
  # Only assignments: remember each value that is a path, forget the rest.
  if (j > nt) { for (k = 1; k <= nt; k++) if (match(tok[k], /^[A-Za-z_][A-Za-z0-9_]*=/)) setvar(substr(tok[k], 1, RLENGTH - 1), substr(tok[k], RLENGTH + 1)); return }
  if (tok[j] == "cd" || tok[j] == "pushd" || tok[j] == "popd") {
    # cd -, popd and a target it cannot resolve make the directory unknown,
    # and an unknown directory is never refused.
    if (tok[j] == "popd" || tok[j + 1] == "-" || substr(tok[j + 1], 1, 1) == "-") CWD = ""
    else CWD = (j + 1 <= nt) ? resolve(CWD, tok[j + 1]) : HOME
    return
  }
  if (tok[j] != "git" && tok[j] !~ /\/git$/) return
  g = CWD; k = j + 1
  while (k <= nt && substr(tok[k], 1, 1) == "-") {
    if (tok[k] == "-C") { g = (k + 1 <= nt) ? resolve(g, tok[k + 1]) : ""; k += 2; continue }
    if (tok[k] ~ /^(-c|--git-dir|--work-tree|--namespace|--config-env)$/) { k += 2; continue }
    k++
  }
  if (k > nt) return
  sub_ = tok[k]
  if (sub_ == "worktree") { if (tok[k + 1] != "add") return; k++ }
  if (sub_ != "clone" && sub_ != "worktree" && sub_ != "commit") return
  if (sub_ == "commit") { if (volatile(g)) deny("a commit in the repo at", g); return }
  np = 0
  for (k = k + 1; k <= nt; k++) {
    if (tok[k] == "--") continue
    if (substr(tok[k], 1, 1) == "-") { if (takes_value(sub_, tok[k])) k++; continue }
    pos[++np] = tok[k]
  }
  if (np == 0) return
  if (sub_ == "worktree") { dest = resolve(g, pos[1]); if (volatile(dest) && !volatile(g)) deny("a git worktree at", dest); return }
  if (np >= 2) dest = resolve(g, pos[2])
  else { base = pos[1]; sub(/\/+$/, "", base); sub(/\.git$/, "", base); sub(/^.*[\/:]/, "", base); dest = resolve(g, base) }
  src = pos[1]
  if (src ~ /^\// || src ~ /^~/ || src ~ /^\$/ || src ~ /^\.\.?\//) { src = resolve(g, src); if (volatile(src)) return }
  if (volatile(dest)) deny("a git clone at", dest)
}
function setvar(name, val,   p) { p = resolve(CWD, val); if (p != "" && val != "") vars[name] = p; else delete vars[name] }
function flush() { check(); delete tok; nt = 0 }
function addtok() { if (have) { tok[++nt] = cur }; cur = ""; have = 0 }
BEGIN { RS = "\001"; BT = "\140" }
{
  HOME = ENVIRON["HOME"]; TMPD = ENVIRON["TMPDIR"]; TD = strip(ENVIRON["WALNUT_TASK_DIR"])
  cmd = jstr($0, "command"); CWD = jstr($0, "cwd"); if (CWD == "") CWD = ENVIRON["PWD"]
  n = length(cmd); q = ""; cur = ""; have = 0; nt = 0; hd = ""; nd = 0
  for (i = 1; i <= n && !denied; i++) {
    c = substr(cmd, i, 1)
    if (q == "'") { if (c == "'") q = ""; else cur = cur c; continue }
    if (q == "\"") {
      if (c == "\\" && i < n) { i++; cur = cur substr(cmd, i, 1); continue }
      if (c == "\"") q = ""; else cur = cur c; continue
    }
    if (c == "'" || c == "\"") { q = c; have = 1; continue }
    # $(...) and backticks stay inside the word they build (d=$(mktemp -d)).
    if (c == "$" && substr(cmd, i + 1, 1) == "(") {
      dep = 0
      for (; i <= n; i++) { c = substr(cmd, i, 1); cur = cur c; if (c == "(") dep++; else if (c == ")" && --dep == 0) break }
      have = 1; continue
    }
    if (c == BT) {
      cur = cur c; for (i++; i <= n; i++) { c = substr(cmd, i, 1); cur = cur c; if (c == BT) break }
      have = 1; continue
    }
    if (c == "\\" && i < n) { i++; c = substr(cmd, i, 1); if (c != "\n") { cur = cur c; have = 1 }; continue }
    if (c == "<" && substr(cmd, i, 2) == "<<" && substr(cmd, i, 3) != "<<<") {
      # A heredoc body is data (often a script being written), never a command here.
      addtok(); i += 2; if (substr(cmd, i, 1) == "-") i++
      while (substr(cmd, i, 1) == " ") i++
      hd = ""
      while (i <= n && substr(cmd, i, 1) !~ /[ \t\n;&|<>()]/) { c = substr(cmd, i, 1); if (c != "'" && c != "\"" && c != "\\") hd = hd c; i++ }
      i--; continue
    }
    if (c == "\n" && hd != "") {
      addtok(); flush()
      rest = substr(cmd, i + 1); e = 0
      while (rest != "") {
        nl = index(rest, "\n"); line = nl ? substr(rest, 1, nl - 1) : rest
        sub(/^\t+/, "", line)
        i += (nl ? nl : length(rest))
        if (line == hd) { e = 1; break }
        rest = nl ? substr(rest, nl + 1) : ""
      }
      hd = ""; continue
    }
    if (c == " " || c == "\t") { addtok(); continue }
    # A subshell's cd ends with it.
    if (c == "(") { addtok(); flush(); dirs[++nd] = CWD; continue }
    if (c == ")") { addtok(); flush(); if (nd > 0) CWD = dirs[nd--]; continue }
    if (c ~ /[;&|\n]/) { addtok(); flush(); continue }
    cur = cur c; have = 1
  }
  if (!denied) { addtok(); flush() }
}
`

/** The hook command: a fast `case` bail-out, then the awk check. */
export const GIT_TMP_GUARD_COMMAND = [
  '[ -n "$WALNUT_TASK_DIR" ] || exit 0',
  'in=$(cat 2>/dev/null)',
  'case $in in *clone*|*worktree*|*commit*) ;; *) exit 0 ;; esac',
  // A huge command (a file written through a heredoc) is never parsed: the awk
  // is quadratic on some awks, and an allowed command must not wait on it.
  '[ ${#in} -le 100000 ] || exit 0',
  `msg=$(printf '%s' "$in" | awk '${GUARD_AWK.replace(/'/g, `'\\''`)}' 2>/dev/null)`,
  // Only the refusal text refuses: an awk that fails prints nothing, and allows.
  'case $msg in "Walnut refused"*) ;; *) exit 0 ;; esac',
  // A deny decision on stdout: the engine hands the model the reason alone
  // (exit 2 would also quote this whole command back into the transcript).
  'printf \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\\n\' "$msg"',
  'exit 0',
].join('\n')

/** Seconds the engine waits for the hook before it gives up on it. */
const HOOK_TIMEOUT_SECS = 10

export function gitTmpGuardHooks(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  if (env.WALNUT_TMP_GIT_GUARD === '0') return null
  return {
    PreToolUse: [{
      matcher: 'Bash',
      hooks: [{ type: 'command', command: GIT_TMP_GUARD_COMMAND, timeout: HOOK_TIMEOUT_SECS }],
    }],
  }
}
