/**
 * The PostToolUse hook (matcher `Write`) that reminds a session when it has
 * just written a draft, plan, note or evidence file into a temp directory:
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
 * Why Write only: a file reaches /tmp through a Write first, and that is when
 * the note is useful; an Edit of the same file would repeat it on every change.
 * A heredoc in Bash is not covered (a command is not a file path).
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
BEGIN { RS = "\001" }
{
  TMPD = ENVIRON["TMPDIR"]; TD = strip(ENVIRON["WALNUT_TASK_DIR"])
  p = jstr($0, "file_path"); cwd = jstr($0, "cwd")
  if (p == "") exit 0
  if (substr(p, 1, 1) != "/") { if (cwd == "") exit 0; p = cwd "/" p }
  p = norm(p)
  if (!volatile(p) || !worthy(below(p))) exit 0
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
  'case $in in *\'"file_path":"/tmp\'*|*\'"file_path":"/private/\'*|*\'"file_path":"/var/folders/\'*|*\'"file_path":"\'[!/]*) ;;',
  '*) [ -n "$TMPDIR" ] || exit 0; case $in in *"\\"file_path\\":\\"${TMPDIR%/}"*) ;; *) exit 0 ;; esac ;;',
  'esac',
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
      matcher: 'Write',
      hooks: [{ type: 'command', command: TMP_WRITE_NOTE_COMMAND, timeout: HOOK_TIMEOUT_SECS }],
    }],
  }
}
