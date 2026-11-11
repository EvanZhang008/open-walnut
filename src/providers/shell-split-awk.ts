/**
 * The awk that splits the command a session typed the way sh would, shared by
 * every Bash hook that judges command words (git-command-awk.ts for the git
 * hooks, typecheck-guard-hook.ts): it reads the command out of the hook's JSON
 * stdin, splits it into words (quotes, escapes, ;, &&, |, subshells; a heredoc
 * body is data and skipped), and calls check() once per simple command with
 * its words in tok[1..nt]. The program that includes it defines check(), and
 * may set `denied = 1` to stop the scan.
 *
 * It needs JSON_AWK's jstr() and TMP_PATH_AWK's strip() (tmp-path-awk.ts), and
 * sets HOME, TMPD (TMPDIR), TD (WALNUT_TASK_DIR) and CWD (the hook's cwd) for
 * the program; a subshell's CWD is restored at its ")" through dirs[]. A
 * command over 100,000 characters (a file written through a heredoc) is never
 * parsed: the scan is quadratic on some awks, and the session waits on it.
 *
 * POSIX awk only (macOS, glibc and busybox hosts all have it).
 */
export const SHELL_SPLIT_AWK = String.raw`function flush() { check(); delete tok; nt = 0 }
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
