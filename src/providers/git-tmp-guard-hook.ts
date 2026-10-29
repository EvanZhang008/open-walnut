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

import { shQuoteAwk } from './tmp-path-awk.js'
import { GIT_COMMAND_AWK } from './git-command-awk.js'

const GUARD_AWK = GIT_COMMAND_AWK + String.raw`
function deny(what, p) {
  printf "%s", jesc("Walnut refused this command: it puts " what " " p ". Temp directories are emptied at every reboot and swept by cleaners, so a clone, worktree or commit there can be lost. " \
    "Put it in your task directory, which survives reboots and is cleaned by Walnut after the task completes: " TD " (for example " TD "/<repo>). " \
    "Only disposable files (screenshots, scratch output, rebuildable builds) belong in /tmp.")
  denied = 1
}
function on_git(sub_, g, pos, np,   dest, src) {
  if (sub_ == "commit") { if (volatile(g)) deny("a commit in the repo at", g); return }
  if (np == 0) return
  if (sub_ == "worktree") { dest = resolve(g, pos[1]); if (volatile(dest) && !volatile(g)) deny("a git worktree at", dest); return }
  dest = clone_dest(g, pos, np)
  src = pos[1]
  if (src ~ /^\// || src ~ /^~/ || src ~ /^\$/ || src ~ /^\.\.?\//) { src = resolve(g, src); if (volatile(src)) return }
  if (volatile(dest)) deny("a git clone at", dest)
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
  `msg=$(printf '%s' "$in" | awk ${shQuoteAwk(GUARD_AWK)} 2>/dev/null)`,
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
