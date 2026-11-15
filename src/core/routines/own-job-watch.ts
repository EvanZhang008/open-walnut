/**
 * A trigger whose check only reads a job of the calling session itself: a Claude Code
 * background command's output (`<tmp>/claude-<uid>/<project>/<session>/tasks/<id>.output`)
 * or one of its subagents' transcripts. Claude Code already wakes the session when that job
 * finishes, so such a trigger only wakes it for nothing (2026-11-15, the org reflection: a
 * 20-minute "validation completion" trigger on a session's own acceptance run fired four times
 * overnight, each turn an ack only). trigger_create warns (src/ops/triggers.ts).
 *
 * Read where the op runs: the caller's own process, on the host its check runs on by default.
 * The script a `run` names is read too, small files only, never in a place macOS guards (a read
 * there puts a dialog on the user's screen).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { macPlace } from '../hosts/mac-places.js'

const SCRIPT_MAX_BYTES = 64 * 1024
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** A Claude Code session's own job files: its background commands' output and its subagents. */
const OWN_JOB_RE = new RegExp(`(${UUID})/(?:tasks|subagents)\\b`, 'gi')
/** Claude Code's background output directory named without a session id (a glob, a variable). */
const CLAUDE_TASKS_RE = /\/claude-\d+\/[^\s'"]*\/tasks\b|\/tasks\/[a-z0-9]{6,}\.output\b/i
/**
 * Anything that looks past the session: the network, a forge or CI, a cloud CLI, another host,
 * Walnut itself. One of these and the check watches something outside, so no warning.
 */
const OUTSIDE_RE = /\b(?:curl|wget|gh|glab|git|ssh|scp|rsync|aws|gcloud|az|kubectl|docker|walnut|walnut-dev|walnut-cloud|xcrun|xcodebuild|fetch|urllib|requests|httpx|http\.client|axios|socket)\b/i
const URL_RE = /\bhttps?:\/\//i

/** Whether the text looks outside: a URL, or one of those words outside a file path (a path's `-walnut` is a name). */
function looksOutside(text: string): boolean {
  if (URL_RE.test(text)) return true
  // A comment's words ("then fetch the exit status") are no command.
  const code = text.split('\n').filter((l) => !/^\s*(?:#|\/\/)/.test(l)).join('\n')
  const words = code.split(/[\s'"`()[\]{},;=]+/).filter((w) => w && !w.includes('/'))
  return OUTSIDE_RE.test(words.join(' '))
}

/** The script files a `run` line names (a word ending in a script extension), resolved against cwd. */
function scriptPaths(run: string, cwd: string | undefined): string[] {
  const home = os.homedir()
  const out: string[] = []
  for (const raw of run.split(/\s+/)) {
    const word = raw.replace(/^['"]|['"]$/g, '')
    if (!/\.(?:py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl)$/i.test(word)) continue
    const expanded = word.startsWith('~/') ? path.join(home, word.slice(2)) : word.replace(/^\$HOME\//, `${home}/`)
    if (expanded.includes('$')) continue
    out.push(path.isAbsolute(expanded) ? expanded : path.resolve(cwd || process.cwd(), expanded))
  }
  return out
}

function readScript(p: string): string | null {
  // macOS folds case, so ~/desktop is ~/Desktop: compared folded, before anything touches the path.
  if (process.platform === 'darwin' && macPlace(p, { home: os.homedir() }, { foldCase: true })) return null
  try {
    // A link is not followed: its target may sit in a guarded place.
    const st = fs.lstatSync(p)
    if (!st.isFile() || st.size > SCRIPT_MAX_BYTES) return null
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/**
 * Whether this text reads the session's own job files: by its id when the caller's session is
 * known (another session's job is not this one's), by Claude Code's layout alone when it is not.
 */
function readsOwnJob(text: string, sid: string | undefined): boolean {
  const ids = [...text.matchAll(OWN_JOB_RE)].map((m) => m[1].toLowerCase())
  if (sid) return ids.includes(sid.toLowerCase())
  return ids.length > 0 || CLAUDE_TASKS_RE.test(text)
}

/**
 * The warning trigger_create gives, or null: the check (its `run` and the scripts it names)
 * reads a job of the calling session and nothing outside it.
 */
export function ownJobWatchWarning(input: { run?: unknown; cwd?: unknown; sid?: string }): string | null {
  const run = typeof input.run === 'string' ? input.run : ''
  if (!run) return null
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : undefined
  const sid = input.sid?.trim() || undefined
  // Its scripts are read only in a session's own process (a session's id is in its env): the server
  // running this op for a session on another host would read its own disk, not that host's.
  const scripts = sid ? scriptPaths(run, cwd).map(readScript).filter((t): t is string => t !== null) : []
  const all = [run, ...scripts].join('\n')
  // A session id here that is not the one in the path (another session's job) is no warning; nor is
  // an older id the session was spawned under, a known gap (gatewaySidAliases in the daemons).
  if (!readsOwnJob(all, sid)) return null
  if (looksOutside(all)) return null
  return 'This check reads a background job of this session (its run_in_background output or a subagent). '
    + 'Claude Code already wakes this session when that job finishes, so this trigger only wakes it for nothing. '
    + 'Unless it also watches something outside this session, delete it (trigger_delete) and end your turn; '
    + 'arm a trigger only on what runs outside this session (CI, a deploy, another host, a person).'
}
