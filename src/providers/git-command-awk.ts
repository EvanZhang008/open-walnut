/**
 * The awk both Bash hooks on git commands share (git-tmp-guard-hook.ts refuses
 * git work in a temp directory, clone-identity-hook.ts gives a clone of a local
 * repository that repository's commit identity): it reads the command a
 * session typed out of the hook's JSON stdin, splits it the way sh would
 * (quotes, escapes, ;, &&, |, subshells, heredoc bodies skipped), follows cd,
 * pushd and the variables the same command sets, and calls
 * on_git(sub_, g, pos, np) for every git clone, worktree add and commit, with
 * the repo directory g it runs in and the clone or worktree positionals in
 * pos[1..np]. The program that includes this defines on_git. One copy, so the
 * two hooks never read a command differently.
 *
 * POSIX awk only. A path it cannot know (another command substitution, an
 * unknown variable) resolves to "", which every caller treats as unknown.
 * Setting `denied = 1` stops the scan (the guard's first refusal is enough).
 */
import { TMP_PATH_AWK } from './tmp-path-awk.js'

export const GIT_COMMAND_AWK = TMP_PATH_AWK + String.raw`
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
# "" when the path cannot be known (command substitution, another variable).
function resolve(base, t) {
  if (is_mktemp(t)) return mktemp_path(t)
  t = expand(t)
  if (t == "" || index(t, "$") || index(t, "\140")) return ""
  if (substr(t, 1, 1) != "/") { if (base == "") return ""; t = base "/" t }
  return norm(t)
}
# Values of these options are separate words; skipping them finds the positionals.
function takes_value(sub_, o) {
  if (sub_ == "clone") return o ~ /^(-b|--branch|-o|--origin|-c|--config|--depth|--reference|--reference-if-able|-u|--upload-pack|--template|--separate-git-dir|-j|--jobs|--filter|--shallow-since|--shallow-exclude|--server-option|--bundle-uri|--ref-format|--revision)$/
  if (sub_ == "worktree") return o ~ /^(-b|-B|--reason)$/
  return 0
}
function check(   j, k, g, sub_, pos, np) {
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
  np = 0
  if (sub_ != "commit") {
    for (k = k + 1; k <= nt; k++) {
      if (tok[k] == "--") continue
      if (substr(tok[k], 1, 1) == "-") { if (takes_value(sub_, tok[k])) k++; continue }
      pos[++np] = tok[k]
    }
  }
  on_git(sub_, g, pos, np)
}
# Where a clone lands: its second positional, else the name git derives from the source.
function clone_dest(g, pos, np,   base) {
  if (np >= 2) return resolve(g, pos[2])
  base = pos[1]; sub(/\/+$/, "", base); sub(/\.git$/, "", base); sub(/^.*[\/:]/, "", base)
  return resolve(g, base)
}
function setvar(name, val,   p) { p = resolve(CWD, val); if (p != "" && val != "") vars[name] = p; else delete vars[name] }
function flush() { check(); delete tok; nt = 0 }
function addtok() { if (have) { tok[++nt] = cur }; cur = ""; have = 0 }
BEGIN { RS = "\001"; BT = "\140" }
{
  HOME = ENVIRON["HOME"]; TMPD = ENVIRON["TMPDIR"]; TD = strip(ENVIRON["WALNUT_TASK_DIR"])
  cmd = jstr($0, "command"); CWD = jstr($0, "cwd"); if (CWD == "") CWD = ENVIRON["PWD"]
  # A huge command (a file written through a heredoc) is never parsed: the scan
  # below is quadratic on some awks, and the session waits on the hook.
  if (length(cmd) > 100000) next
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
}`
