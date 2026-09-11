/**
 * Watcher contract — the prompt and the run summary, as pure functions.
 *
 * Kept IO-free (same split as task-search-agent-contract.ts) so the wording of
 * the rules the watcher runs under is unit-testable without a model, a disk or
 * a server.
 *
 * The prompt's whole job is to make "nothing happened" the comfortable answer.
 * A scheduled watcher fires hundreds of times a day and almost every run should
 * end with no outcome at all; a model that feels it owes the user an action on
 * every tick is what turns a trigger into a spam machine.
 */

/**
 * A watcher gets NO data tools by default, and its `tools` field names them one
 * by one out of two pools: Walnut's read-only allowlist, and the installed
 * plugins' tools.
 *
 * That default is a measured decision, not caution. Every tool schema sits in
 * the prefix of EVERY model round, and a watcher on a 10-minute schedule pays it
 * ~144 times a day. Handing it the whole read-only set for free cost 2,835
 * tokens a round, of which `task_query` (1,128) and `memory_notes_search` (997)
 * were nice-to-haves nobody asked for; the entire mail trio it actually needs is
 * 159. So the cost decision belongs to whoever names a tool, while the SAFETY
 * decision stays where it was: `READ_ONLY_TOOL_NAMES` is fail-closed, and a
 * watcher can only ever name something already in it.
 */

export interface WatcherBudget {
  /** Outcome tool calls allowed in THIS run. */
  outcomesPerRun: number;
  /** New sessions allowed today (across runs). */
  sessionsPerDay: number;
  /** Sessions already started today. */
  sessionsUsedToday: number;
}

export interface WatcherPromptInput {
  /** The user's own natural-language brief. */
  instructions: string;
  /** The note the previous run left for this one. */
  notes: string;
  budget: WatcherBudget;
  /** Names of the data tools this watcher was given (allowlisted plugin tools). */
  dataTools: string[];
  nowIso: string;
  lastRunIso?: string;
}

export const WATCHER_SYSTEM_PROMPT = `You are a watcher. You run unattended on a schedule and look at ONE thing for your user.

Doing nothing is the normal, correct outcome. Most runs find nothing worth interrupting a human for, and reporting that is a success, not a failure. Never invent work to look useful, and never act on something just because it is there — act only on what the user's brief says is worth acting on.

How a run goes:
1. Look. Use the data tools you were given to fetch the current state of the thing you watch.
2. Filter. Call trigger_seen with the ids of everything you just fetched; it returns ONLY the ids you have never looked at before. Ignore the rest — they were handled on an earlier run.
3. Judge. For each new item, decide against the user's brief whether it needs anything.
4. Act, at most a few times, using the trigger_* outcome tools. Nothing else you do reaches the user.
5. Answer with ONE short line saying what you found and did, e.g. "4 new, 1 task created" or "nothing new".

Rules that are enforced in code, not on your honour:
- Every outcome needs a stable "key" derived from the SOURCE item (the message id, the review id). Never a timestamp, a counter or a rephrasing — the key is what stops the same item being acted on twice, and a key that changes between runs defeats it. Reuse the exact id you passed to trigger_seen.
- An outcome whose key was already used is REFUSED. That is the system working; move on, do not retry with a different key.
- You have a small budget of outcomes per run. When it runs out, stop and summarize. Leave what you did not get to; the next run will see it as new.
- You cannot send mail, write files, or change anything outside the trigger_* tools. Do not try.

If something is wrong with the thing you watch (an account is disconnected, a tool errors), say so in your one-line answer instead of acting. Errors are for the user to see, not to work around.`;

export function buildWatcherUserMessage(input: WatcherPromptInput): string {
  const { instructions, notes, budget, dataTools, nowIso, lastRunIso } = input;
  const sessionsLeft = Math.max(0, budget.sessionsPerDay - budget.sessionsUsedToday);
  const lines = [
    'What to watch, in the user\'s own words:',
    instructions.trim(),
    '',
    `Now: ${nowIso}`,
    lastRunIso ? `Previous run: ${lastRunIso}` : 'Previous run: none — this is the first.',
    `Data tools available: ${dataTools.length ? dataTools.join(', ') : '(none — you can only read Walnut\'s own state)'}`,
    `Budget: ${budget.outcomesPerRun} outcome${budget.outcomesPerRun === 1 ? '' : 's'} this run, ${sessionsLeft} new session${sessionsLeft === 1 ? '' : 's'} left today.`,
  ];
  if (notes.trim()) {
    lines.push('', 'The note your previous run left for you:', notes.trim());
  }
  return lines.join('\n');
}

export interface WatcherOutcome {
  tool: string;
  key: string;
  /** Short human label, e.g. a task title. */
  label?: string;
}

/**
 * The line the Routines UI shows for this run. Built from what the outcome
 * tools ACTUALLY did, with the model's own sentence appended as colour — a
 * summary that trusted the model's claim would report a task it never created.
 */
export function summarizeWatcherRun(
  outcomes: WatcherOutcome[],
  response: string,
  opts?: { aborted?: boolean },
): string {
  const counts = new Map<string, number>();
  for (const o of outcomes) counts.set(o.tool, (counts.get(o.tool) ?? 0) + 1);
  const acted = [...counts.entries()]
    .map(([tool, n]) => `${n}× ${tool.replace(/^trigger_/, '')}`)
    .join(', ');
  const said = response.trim().split('\n').filter(Boolean).pop()?.slice(0, 200) ?? '';
  const head = acted || 'no outcomes';
  const parts = [head];
  if (said) parts.push(said);
  if (opts?.aborted) parts.push('(timed out)');
  return parts.join(' — ');
}
