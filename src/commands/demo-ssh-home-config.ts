/**
 * The Demo HOME's own ssh config as OpenSSH must read it inside the Demo (demo-ssh.ts).
 *
 * OpenSSH expands `~/` and `%d` from the OS account, never from $HOME, so a Demo HOME config
 * line `IdentityFile ~/.ssh/id_devbox` names the person's real key, and a relative `Include`
 * reads the person's real ~/.ssh (2026-11-08: the Demo's Connect read
 * /Users/<account>/.ssh/id_ed25519_devbox). Each time the Demo runs ssh or scp, its wrapper
 * writes the Demo HOME config through this awk program: every `~/` and `%d` names the Demo
 * HOME, a relative Include path is read in the Demo's .ssh, and each included file is written
 * the same way to a copy the translated Include names, so Host and Match blocks keep the scope
 * OpenSSH gives an included file. The program reads files and writes only into `out`.
 *
 * After the person's config it names the Demo HOME's default keys (id_rsa, id_ed25519, ...) that
 * exist, or `IdentityFile none` when none does: OpenSSH adds the ACCOUNT's default keys to a host
 * with no IdentityFile, and an IdentityFile it cannot find prints "no such identity" for every one,
 * which buried the one key the person's config named and was missing.
 */

/** POSIX awk (macOS awk, mawk, gawk). Variables: home, sshhome, out (dir for included copies), run (a unique tag). */
export const DEMO_SSH_TRANSLATE_AWK = String.raw`
function shq(s) { gsub(/'/, "'\\''", s); return "'" s "'" }
function homes(s,   o, i, c, p) {
  o = ""
  while ((i = index(s, "~/")) > 0) {
    p = i > 1 ? substr(s, i - 1, 1) : ""
    o = o substr(s, 1, i - 1) ((p == "" || p == " " || p == "\t" || p == "=" || p == "\"" || p == ",") ? home "/" : "~/")
    s = substr(s, i + 2)
  }
  s = o s
  o = ""
  for (i = 1; i <= length(s); i++) {
    c = substr(s, i, 2)
    if (c == "%%") { o = o c; i++ }
    else if (c == "%d") { o = o home; i++ }
    else o = o substr(s, i, 1)
  }
  return o
}
function globword(p,   o, i, c) {
  o = ""
  for (i = 1; i <= length(p); i++) {
    c = substr(p, i, 1)
    o = o ((c == "*" || c == "?" || c == "[" || c == "]") ? c : shq(c))
  }
  return o
}
function copyname(f,   n) {
  n = f
  gsub(/_/, "__", n); gsub(/\//, "_s", n); gsub(/[^A-Za-z0-9._-]/, "_x", n)
  return out "/" n
}
function emit(file, dest, depth,   line, rest, args, n, i, a, cmd, f, copy, tmp, w) {
  tmp = dest == "" ? "" : dest ".tmp." run
  while ((getline line < file) > 0) {
    w = homes(line)
    if (depth < 16 && match(line, /^[ \t]*[Ii][Nn][Cc][Ll][Uu][Dd][Ee]([ \t]*=[ \t]*|[ \t]+)/)) {
      rest = substr(line, RLENGTH + 1)
      n = split(rest, args, /[ \t]+/)
      w = ""
      for (i = 1; i <= n; i++) {
        a = args[i]
        if (a == "") continue
        if (substr(a, 1, 1) == "#") break
        gsub(/"/, "", a)
        a = homes(a)
        if (substr(a, 1, 1) != "/") a = sshhome "/" a
        cmd = "for f in " globword(a) "; do [ -f \"$f\" ] && printf '%s\\n' \"$f\"; done"
        while ((cmd | getline f) > 0) {
          copy = copyname(f)
          emit(f, copy, depth + 1)
          w = w " \"" copy "\""
        }
        close(cmd)
      }
      w = w == "" ? "# Walnut Demo: an Include that matched no file" : "Include" w
    }
    if (tmp == "") print w
    else print w > tmp
  }
  close(file)
  if (tmp != "") {
    printf "" >> tmp
    close(tmp)
    system("mv -f " shq(tmp) " " shq(dest))
  }
}
function exists(f,   x, r) { r = (getline x < f); close(f); return r >= 0 }
BEGIN {
  emit(sshhome "/config", "", 0)
  n = split("id_rsa id_ecdsa id_ecdsa_sk id_ed25519 id_ed25519_sk", ids, " ")
  print "Host *"
  k = 0
  for (i = 1; i <= n; i++) if (exists(sshhome "/" ids[i])) { print "  IdentityFile \"" sshhome "/" ids[i] "\""; k++ }
  if (!k) print "  IdentityFile none"
}
`
