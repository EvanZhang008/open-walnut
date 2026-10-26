/**
 * The awk functions both temp-directory hooks share (git-tmp-guard-hook.ts
 * refuses git work there, tmp-write-note-hook.ts reminds about drafts there):
 * reading one string field out of the hook's JSON stdin, path normalising, and
 * the one answer to "is this path in a temp directory". One copy, so the two
 * hooks never disagree about what a temp directory is.
 *
 * POSIX awk only (macOS, glibc and busybox hosts all have it; a remote host
 * may have no node). Callers set HOME, TMPD (the session's TMPDIR) and TD (its
 * WALNUT_TASK_DIR, trailing slashes stripped) before calling volatile().
 */
export const TMP_PATH_AWK = String.raw`
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
`

/** An awk program as one single-quoted sh word. */
export function shQuoteAwk(program: string): string {
  return `'${program.replace(/'/g, `'\\''`)}'`
}
