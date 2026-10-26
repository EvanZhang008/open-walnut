/**
 * Where a session keeps its work: one rule, the same text for Main, a lead, a
 * worker and the Personal AI. ONE source, read by the task session prompt
 * (session-context.ts), the operating contract (self-knowledge-contract.ts),
 * the `walnut` skill, and the `task_dir` op's help, which every session can
 * read in `walnut tools list` even when it was spawned before the rule;
 * tests/core/work-place-rule.test.ts checks each one.
 *
 * Why (2026-10-25): a Mac restart emptied /tmp, and with it several tasks'
 * temporary clones, one task's only copy of an unmerged commit, and evidence
 * kept for later. The program side is the task directory (src/lib/task-dir.ts),
 * made by the host's daemon for every session, and the guard that refuses a
 * git clone, worktree or commit in a temp directory
 * (src/providers/git-tmp-guard-hook.ts), plus the note after a Write of a draft,
 * plan or evidence file there (src/providers/tmp-write-note-hook.ts; 2026-10-26:
 * a Slack draft and a plan in /tmp were swept the same day). This text is how a
 * session learns all three.
 */
import { TASK_DIR_KEEP_DAYS } from '../lib/task-dir.js'

export const WORK_PLACE_RULE = `## Where work lives

Temp directories (/tmp and the OS temp dir) are emptied at every reboot and swept by cleaners between boots. Only what you can lose goes there: screenshots, one-off scratch output, builds you can rebuild.
- Everything you must not lose goes in your task directory, \`$WALNUT_TASK_DIR\`: drafts, plans and notes, temporary clones and worktrees, unmerged commits, candidate builds, evidence and reports. Name what you put there by purpose (\`<repo>\`, \`evidence/\`, \`reports/\`) and remove what you no longer need when you finish.
- Walnut makes it on the host your session runs on, keeps it across reboots, and removes it ${TASK_DIR_KEEP_DAYS} days after the task completes, never while a repo in it holds changes or commits that exist nowhere else. What someone needs after that belongs in a merged commit, the task's note or summary, or a note.
- Walnut refuses a git clone, git worktree add or git commit in a temp directory, and flags a draft, plan or note saved there with Write. When \`$WALNUT_TASK_DIR\` is empty, \`walnut tools call task_dir\` makes it and prints its path.`

/** The prompt's line naming this session's own directory; path null = only the env var is known. */
export function taskDirLine(taskDir: string | null): string {
  return taskDir
    ? `Your task directory on this host is ${taskDir} (also \`$WALNUT_TASK_DIR\`).\n\n`
    : 'Your task directory is `$WALNUT_TASK_DIR` on the host your session runs on.\n\n'
}
