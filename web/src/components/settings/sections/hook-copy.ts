/**
 * Human names and one-line help for the hooks Walnut ships (N22). The server
 * writes hook names and descriptions for developers (`task.cwd`, `-p`,
 * `CronCreate`, file paths); the pane shows these instead and keeps the raw
 * server text in `title` and under "What it does". A hook the map does not
 * know falls back to hook-text.ts, and any id left in server text is set in
 * code by `codeRuns` below.
 *
 * Server copy rewrite list (for src/core/hooks and session-hooks, not done
 * here): every entry below is the suggested replacement for the server's own
 * `name` and first sentence of `description`.
 */
export const HOOK_COPY: Record<string, { name: string; help: string }> = {
  'turn-complete-triage': { name: 'Summarize each turn', help: "Updates the task's note, summary and phase when a turn ends." },
  'message-send-triage': { name: 'Cancel a pending summary when you reply', help: 'Your new message replaces the summary of the last turn.' },
  'session-auto-title': { name: 'Name new sessions', help: 'Replaces the placeholder title once your first real message arrives.' },
  'session-auto-title-turn-complete': { name: 'Name sessions started elsewhere', help: 'Names a session after its first turn when it was started from a phone.' },
  'session-error-notify': { name: 'Record session errors', help: 'Writes session errors to the log.' },
  'cwd-rename-detector': { name: 'Follow a renamed working folder', help: "Updates the task's folder when a session renames the one it works in." },
  'session-request-watch': { name: 'Chase unanswered requests', help: 'Tells a session when the one it asked ends its turn without replying.' },
  'askuserquestion-p-mode-correction': { name: 'Fix questions asked in background sessions', help: 'Tells the model to write its question as text, since no one can answer the pop-up.' },
  'session-auto-continue': { name: 'Continue after repeated errors', help: 'Sends one delayed "continue" when a turn gives up after retrying.' },
  'auto-deny-stale-permissions': { name: 'Decline old permission prompts', help: 'A new message declines prompts left from the last turn, so the turn can go on.' },
  'session-only-cron-policy': { name: 'Keep scheduled tasks in their session', help: 'Blocks scheduled tasks that would outlive their session and run in another one.' },
  'foreign-cron-fire-marker': { name: 'Mark scheduled tasks from another session', help: 'Shows where a scheduled task came from when another session started it.' },
  'turn-error-auto-retry': { name: 'Retry turns cut off by the provider', help: 'Resumes a turn after a timeout or a dropped stream, waiting longer each time.' },
  'permission-auto-respond-by-mode': { name: 'Answer permission prompts in bypass mode', help: 'Approves prompts itself when the session runs in bypass mode with auto approve on.' },
};

/** A token that is an identifier, path, flag or env name rather than a word. */
const CODE_TOKEN = new RegExp([
  String.raw`\bhooks\.[\w.[\]"-]+`,           // hooks.overrides["x"].enabled
  String.raw`\bclaude(?: --?[a-z][\w-]*)?(?![\w-])`, // the claude command, claude -p
  String.raw`\{[a-z]+\}\/[^\s,;)]+`,          // {cwd}/.claude/scheduled_tasks.json
  String.raw`~\/[\w./-]+`,                     // ~/.claude/settings.json
  String.raw`(?:[\w.-]+\/)+[\w*-]+\.[a-z]{1,5}\b`, // core/session-auto-continue.ts
  String.raw`\b[A-Z][A-Z0-9]*(?:_[A-Z0-9*]+)+\*?`, // NEED_ACTION, WALNUT_AUTO_CONTINUE_*
  String.raw`\b[a-z]+(?:_[a-z0-9]+)+\b`,      // auto_approve_bypass
  String.raw`\b[a-z]+\.[a-z_]+\b`,            // task.cwd
  String.raw`(?<![\w-])--?[a-z][\w-]*`,       // -p, --worktree
  String.raw`\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b`, // AskUserQuestion, CronCreate
  String.raw`\bTOCTOU\b`,
].join('|'), 'g');

/** Text split into plain runs and code runs, for rendering ids in `<code>`. */
export function codeRuns(text: string): Array<{ code: boolean; text: string }> {
  const out: Array<{ code: boolean; text: string }> = [];
  let last = 0;
  for (const m of text.matchAll(CODE_TOKEN)) {
    const at = m.index ?? 0;
    // A path or id that ends a sentence keeps its period outside the code.
    const tok = m[0].replace(/[.,]+$/, '');
    if (!tok) continue;
    if (at > last) out.push({ code: false, text: text.slice(last, at) });
    out.push({ code: true, text: tok });
    last = at + tok.length;
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) });
  return out;
}
