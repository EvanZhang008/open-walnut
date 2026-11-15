/**
 * The PostToolUse hook (matcher `Write|Bash`) that reminds a session when it has
 * just written a draft, plan, note or evidence file into a temp directory, by Write
 * or by a Bash command (a `>`/`>>` target, a heredoc's too, `tee`, `cp`/`mv`/`install`):
 * one line of context telling it the file can be lost and where it belongs
 * (its task directory, src/lib/task-dir.ts). It never refuses and never
 * touches the permission decision; the write has already happened.
 *
 * Why (2026-10-26): a Slack draft and a plan file written to /tmp were
 * deleted by the temp cleaner the same day. The git guard
 * (git-tmp-guard-hook.ts) covers clones, worktrees and commits only.
 *
 * What counts (decided from the path alone, never the content):
 * - prose formats always: .md .markdown .mdx .rst .org .adoc;
 * - any other file whose name or one of whose directories carries a word like
 *   draft, plan, notes, evidence, report, summary, handoff, todo, commit-msg;
 * - never images, video, audio or .log files, and never a file in the task
 *   directory. Screenshots and test output stay quiet.
 * Why not Edit: a file reaches /tmp through a Write or a command first, and that
 * is when the note is useful; an Edit of the same file would repeat it on every
 * change. A temp path handed on in text (a Walnut op's arguments, a turn's final
 * text) is src/lib/tmp-draft-path.ts, which judges a path the same way
 * (tests/lib/tmp-draft-path.test.ts runs both on one table). 2026-11-04: a task
 * asked the user a question naming the temp folder its draft was in, and nothing
 * flagged it. A Bash command's data dumps (.json, .csv, .patch) stay quiet.
 *
 * PostToolUse `hookSpecificOutput.additionalContext` is the CLI's own way to
 * add context after a tool (schema read from CLI 2.1.284; older CLIs have it
 * too). POSIX sh + awk like the git guard, since a remote host may have no
 * node. WALNUT_TMP_WRITE_NOTE=0 on the server turns it off; with no
 * WALNUT_TASK_DIR in the session's env (an older daemon) it says nothing.
 */
import { TMP_PATH_AWK, shQuoteAwk } from './tmp-path-awk.js'

const NOTE_AWK = TMP_PATH_AWK + String.raw`
# The part of p below the temp root it sits in ("" when none): the words that
# decide are the ones the session chose, never the temp dir's own path.
function below(p,   r) {
  r = TMPD != "" ? norm(TMPD) : ""
  if (r != "" && under(p, r)) return substr(canon(p), length(canon(strip(r))) + 2)
  if (under(p, "/tmp")) return substr(canon(p), 6)
  if (under(p, "/var/folders")) return substr(canon(p), 14)
  return ""
}
# camelCase words apart: slackDraft is slack-draft (PLAN.MD stays one word).
function words(s,   i, c, prev, out) {
  out = ""; prev = ""
  for (i = 1; i <= length(s); i++) { c = substr(s, i, 1); if (c ~ /[A-Z]/ && prev ~ /[a-z0-9]/) out = out "-"; out = out c; prev = c }
  return tolower(out)
}
function worthy(rel,   n, seg, i, base, ext, stem, k) {
  # Claude Code's own scratch tree: its project folder's name is the repo's, never a draft's.
  if (rel ~ /^claude-[0-9]+(\/|$)/) return 0
  n = split(words(rel), seg, "/"); base = seg[n]
  k = 0; for (i = length(base); i > 1; i--) if (substr(base, i, 1) == ".") { k = i; break }
  ext = k ? substr(base, k + 1) : ""; stem = k ? substr(base, 1, k - 1) : base
  if (ext ~ /^(png|jpe?g|gif|webp|heic|bmp|tiff?|svg|ico|mp4|mov|webm|mkv|avi|mp3|wav|m4a|ogg|flac|log|html?|gz|tgz|zip|tar|bz2|xz|7z)$/) return 0
  for (i = 1; i < n; i++) if (seg[i] ~ /^(playwright-report|test-results|coverage|node_modules)$/) return 0
  if (ext ~ /^(md|markdown|mdx|rst|org|adoc)$/) return 1
  seg[n] = stem
  for (i = 1; i <= n; i++) if (seg[i] ~ /(^|[-_. ])(drafts?|plans?|notes?|evidence|reports?|summary|summaries|handoff|todo|commit-?msg|msg|messages?|pr-?body|pr-?desc|desc|description|comments?|letter|reply|memo)([-_. 0-9]|$)/) return 1
  return 0
}
# p inside single quotes for a shell.
function sq(p,   out, i, c) { out = ""; for (i = 1; i <= length(p); i++) { c = substr(p, i, 1); out = out (c == "'" ? "'\\''" : c) }; return "'" out "'" }
# A word of a shell command as an absolute path ("" when unknown: a $ or a backtick other than
# a leading $TMPDIR, a word in the task directory).
function absw(w) {
  gsub(/["']/, "", w); gsub(/\002/, " ", w)
  if (index(w, "\003")) return ""
  if (w ~ /^\$\{?TMPDIR\}?(\/|$)/) { if (TMPD == "") return ""; sub(/^\$\{?TMPDIR\}?/, "", w); w = strip(TMPD) w }
  else if (w ~ /^\$\{?WALNUT_TASK_DIR\}?(\/|$)/) return ""
  else if (w ~ /^~\//) w = ENVIRON["HOME"] substr(w, 2)
  if (w == "" || index(w, "$") || index(w, sprintf("%c", 96))) return ""
  if (substr(w, 1, 1) != "/") { if (cwd == "") return ""; w = cwd "/" w }
  return norm(w)
}
# The first file a shell wrote that counts. Data a command dumps (pr-comments.json, a .csv or a
# .patch) is output, whatever its name says.
function cand(w) { w = absw(w); if (w != "" && p == "" && volatile(w) && worthy(below(w)) && tolower(w) !~ /\.(json|jsonl|ndjson|csv|tsv|out|patch|diff|xml|ya?ml)$/) p = w }
# Inside quotes nothing is an operator: a space is \002 (the quoted word stays one) and every
# > ; | & or newline is \003 (git commit -m "x > /tmp/y/plan.md" writes nothing).
function masked(s,   out, i, c, q) {
  out = ""; q = ""
  for (i = 1; i <= length(s); i++) {
    c = substr(s, i, 1)
    if (q != "") { if (c == q) q = ""; else if (c == " " || c == "\t") c = "\002"; else if (c ~ /[>;|&\n]/) c = "\003" }
    else if (c == "\"" || c == "'") q = c
    out = out c
  }
  return out
}
# The files a Bash command wrote: a > or >> target (a heredoc's too), tee's, cp/mv/install's.
# Split on ; | && || and newlines; a heredoc body is data, so only what comes before it counts.
function shell(cmd,   segs, ns, i, j, n, t, w, nm, k, a, o, no, td, dest) {
  if ((i = index(cmd, "<<")) > 0 && (j = index(substr(cmd, i), "\n")) > 0) cmd = substr(cmd, 1, i + j - 2)
  if (length(cmd) > 20000) cmd = substr(cmd, 1, 20000)
  cmd = masked(cmd)
  gsub(/&&|\|\||[;|\n]/, "\001", cmd)
  ns = split(cmd, segs, "\001")
  for (i = 1; i <= ns; i++) {
    w = segs[i]; gsub(/^[ \t(]+|[ \t)]+$/, "", w); n = split(w, t, /[ \t]+/)
    k = 0; split("", a); split("", o)
    for (j = 1; j <= n; j++) {
      w = t[j]
      if (w ~ /^[0-9&]*>>?\|?$/) { if (j < n) cand(t[++j]); continue }
      if (w ~ /^[0-9&]*>>?\|?[^&>|]/) { sub(/^[0-9&]*>>?\|?/, "", w); cand(w); continue }
      if (k == 0 && (w ~ /^[A-Za-z_][A-Za-z0-9_]*=/ || w == "sudo" || w == "command" || w == "nohup")) continue
      a[++k] = w
    }
    nm = a[1]; sub(/.*\//, "", nm)
    if (nm == "cd" && k >= 2) { w = absw(a[2]); if (w != "") cwd = w }
    else if (nm == "tee") { for (j = 2; j <= k; j++) if (a[j] !~ /^-/) cand(a[j]) }
    else if (nm == "cp" || nm == "mv" || nm == "install") {
      no = 0; td = ""
      for (j = 2; j <= k; j++) { if (a[j] == "-t" && j < k) td = a[++j]; else if (a[j] ~ /^--target-directory=/) td = substr(a[j], 20); else if (a[j] !~ /^-/) o[++no] = a[j] }
      if (td == "" && no >= 2) { td = o[no--]; dest = absw(td); if (td !~ /\/$/ && (dest == "" || system("test -d " sq(dest) " 2>/dev/null") != 0)) { cand(td); td = "" } }
      if (td != "" && (dest = absw(td)) != "") for (j = 1; j <= no; j++) { w = o[j]; sub(/.*\//, "", w); cand(dest "/" w) }
    }
  }
}
BEGIN { RS = "\001" }
{
  TMPD = ENVIRON["TMPDIR"]; TD = strip(ENVIRON["WALNUT_TASK_DIR"])
  cwd = jstr($0, "cwd")
  if (jstr($0, "tool_name") == "Bash") { p = ""; shell(jstr($0, "command")) }
  else {
    p = jstr($0, "file_path")
    if (p != "" && substr(p, 1, 1) != "/") p = cwd == "" ? "" : cwd "/" p
    if (p != "") { p = norm(p); if (!volatile(p) || !worthy(below(p))) p = "" }
  }
  if (p == "") exit 0
  printf "%s", jesc("Walnut note: you wrote " p " in a temp directory. Temp directories are emptied at every reboot and swept by cleaners between boots, so a draft, plan, note or evidence file there can be lost. " \
    "Move it, or the folder it belongs to, into your task directory, which survives reboots (for example: mv " sq(p) " " sq(TD "/") "), and write files like it there from now on. Screenshots and scratch output can stay in /tmp.")
}
`

/** The hook command: a `case` on the path, a size cap, then the awk check. */
export const TMP_WRITE_NOTE_COMMAND = [
  '[ -n "$WALNUT_TASK_DIR" ] || exit 0',
  'in=$(cat 2>/dev/null)',
  // The payload carries the whole file: a path in a temp dir (or a relative one)
  // is the cheap first test. The same text inside the content is JSON-escaped
  // (\\"file_path\\":) and never matches.
  // A Bash command: one that names a temp dir at all (the output is in the payload too: cheap).
  'case $in in *\'"tool_name":"Bash"\'*) case $in in *\'/tmp\'*|*\'/var/folders/\'*|*TMPDIR*) ;; *) exit 0 ;; esac ;;',
  '*) case $in in *\'"file_path":"/tmp\'*|*\'"file_path":"/private/\'*|*\'"file_path":"/var/folders/\'*|*\'"file_path":"\'[!/]*) ;;',
  '*) [ -n "$TMPDIR" ] || exit 0; case $in in *"\\"file_path\\":\\"${TMPDIR%/}"*) ;; *) exit 0 ;; esac ;;',
  'esac ;; esac',
  // A very large write is never parsed: the note must not hold the session up.
  '[ ${#in} -le 4000000 ] || exit 0',
  `msg=$(printf '%s' "$in" | awk ${shQuoteAwk(NOTE_AWK)} 2>/dev/null)`,
  'case $msg in "Walnut note:"*) ;; *) exit 0 ;; esac',
  'printf \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\\n\' "$msg"',
  'exit 0',
].join('\n')

const HOOK_TIMEOUT_SECS = 10

export function tmpWriteNoteHooks(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | null {
  if (env.WALNUT_TMP_WRITE_NOTE === '0') return null
  return {
    PostToolUse: [{
      matcher: 'Write|Bash',
      hooks: [{ type: 'command', command: TMP_WRITE_NOTE_COMMAND, timeout: HOOK_TIMEOUT_SECS }],
    }],
  }
}
