/**
 * The PreToolUse hook (matcher `AskUserQuestion`) that holds a question to the user written in another
 * language than his Reply language setting names: the session's own `walnut` CLI judges it (op
 * reply_language_check; the hook's input goes on stdin, wrapped as `hook_input`, so no content rides a
 * command line) and, when it fails, answers `permissionDecision: deny` with the reason, so the session
 * asks again in his language before he sees the question. Only a deny answer is printed: an older CLI
 * that knows no reply_language_check, a server that is away, or the experiment off asks as written.
 * The other words for him are held by the send gate (ops/reply-language-gate.ts); a chat reply never is.
 * WALNUT_REPLY_LANGUAGE_GATE=0 on the server leaves the hook out; in the session's env it silences it.
 *
 * The other direction rides the same command: the tools and Bash commands the user listed as ones
 * other people read (config session.outward_language, lib/outward-language.ts) get it too, so their
 * words go out in the language he set for them. A Bash call is asked about only when its input
 * matches one of his command patterns (grep, in the hook's shell), so every other command runs with
 * no call to Walnut; one that is asked about hands in the files it reads its words from.
 */
import { COMMAND_FILE_RE, outwardCommandPrefilter, outwardHookMatcher, type OutwardSetting } from '../lib/outward-language.js'


export const REPLY_LANGUAGE_HOOK_COMMAND = [
  'in=$(cat 2>/dev/null); [ "$WALNUT_REPLY_LANGUAGE_GATE" = 0 ] && exit 0',
  "out=$({ printf '{\"hook_input\":'; printf '%s' \"$in\"; printf '}'; } | walnut tools call reply_language_check - 2>/dev/null)",
  `case "$out" in *'"permissionDecision"'*) printf '%s\\n' "$out" ;; esac`,
  'exit 0',
].join('\n')

/** Seconds the CLI waits for the hook before it asks the question without it. */
const HOOK_TIMEOUT_SECS = 5

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * Reads the hook input on stdin and prints the call for Walnut: the input, and the text of the
 * files a Bash command reads its words from (lib/outward-language.ts COMMAND_FILE_RE, handed in as
 * WALNUT_OUTWARD_FILE_RE), read here on the session's own machine: at most 5, 200 KB each. Double
 * quotes only: it rides a single-quoted shell word.
 */
const FILES_PY = [
  'import sys, json, re, os',
  'd = json.load(sys.stdin)',
  'ti = d.get("tool_input") or {}',
  'cmd = ti.get("command") if isinstance(ti.get("command"), str) else ""',
  'rx = re.compile(os.environ["WALNUT_OUTWARD_FILE_RE"])',
  'cwd = d.get("cwd") or os.getcwd()',
  'files = {}',
  'for m in rx.finditer(cmd):',
  '    p = m.group(2) or m.group(4) or m.group(6) or m.group(8)',
  '    if not p or p in files or len(files) >= 5: continue',
  '    q = os.path.expanduser(p)',
  '    q = q if os.path.isabs(q) else os.path.join(cwd, q)',
  '    try:',
  '        if os.path.isfile(q) and os.path.getsize(q) <= 200000: files[p] = open(q, encoding="utf-8", errors="replace").read()',
  '    except Exception: pass',
  'print(json.dumps({"hook_input": d, "files": files}))',
].join('\n')

/**
 * The hook's command for words other people read. A Bash call that is not one of the user's listed
 * commands ends here (grep says no match: 1; an error, 2, asks Walnut, so a pattern this grep cannot
 * read never lets a listed command through). A Bash call that goes on hands Walnut the text of the
 * files it reads its words from too (python3 where there is one; else the command alone). Walnut's
 * runners on another host (host_exec) are always asked: their files are there, not here.
 */
export function outwardHookCommand(prefilter: string | null): string {
  const bash = `*'"tool_name":"Bash"'*`
  return [
    'in=$(cat 2>/dev/null); [ "$WALNUT_REPLY_LANGUAGE_GATE" = 0 ] && exit 0',
    ...(prefilter ? [`case "$in" in ${bash}) printf '%s' "$in" | grep -qE -e ${shellQuote(prefilter)} 2>/dev/null; [ $? -eq 1 ] && exit 0 ;; esac`] : []),
    // macOS without its command line tools has only a /usr/bin/python3 stub that opens an install dialog.
    `req=''; case "$in" in ${bash}) if [ "$(uname)" != Darwin ] || [ "$(command -v python3)" != /usr/bin/python3 ] || xcode-select -p >/dev/null 2>&1; then req=$(printf '%s' "$in" | WALNUT_OUTWARD_FILE_RE=${shellQuote(COMMAND_FILE_RE.source)} python3 -c ${shellQuote(FILES_PY)} 2>/dev/null); fi ;; esac`,
    `[ -n "$req" ] || req=$(printf '{"hook_input":'; printf '%s' "$in"; printf '}')`,
    "out=$(printf '%s' \"$req\" | walnut tools call reply_language_check - 2>/dev/null)",
    `case "$out" in *'"permissionDecision"'*) printf '%s\\n' "$out" ;; esac`,
    'exit 0',
  ].join('\n')
}

export function replyLanguageHooks(env: NodeJS.ProcessEnv = process.env, outward: OutwardSetting | null = null): Record<string, unknown> | null {
  if (env.WALNUT_REPLY_LANGUAGE_GATE === '0') return null
  const groups: unknown[] = [{
    matcher: 'AskUserQuestion',
    hooks: [{ type: 'command', command: REPLY_LANGUAGE_HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECS }],
  }]
  const matcher = outwardHookMatcher(outward)
  if (matcher) groups.push({ matcher, hooks: [{ type: 'command', command: outwardHookCommand(outwardCommandPrefilter(outward)), timeout: HOOK_TIMEOUT_SECS }] })
  return { PreToolUse: groups }
}
