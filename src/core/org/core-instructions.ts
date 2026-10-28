/**
 * Walnut's default core instructions for the CEO (Main) and a VP (a project lead): the one short
 * rule each reads at the top of its role, which the user sees and may rewrite on the Org page and
 * in the session menu (Task.org_instructions). 2026-10-27, the user: "can u make walnut able to
 * inject the core instruction for each agent? such as main, u don't do task yourself, u delegate
 * to other VP or task directly", after Main wrote a script and ran a device test itself.
 *
 * The prompt carries the user's own words when they set some, else this default
 * (sessions/session-context.ts orgInstructionsLine). Words saved equal to the default are no words
 * of the user's: the role keeps following the default, so a later change to it reaches the agent.
 * A task with no org role has none: the team charter is its core rule.
 *
 * Pure and shared: the web imports it through `@open-walnut/org-tree`; iOS reads it from
 * GET /api/v1/org/settings (`defaultInstructions`).
 */

export type CoreInstructionRole = 'main' | 'lead';

export const DEFAULT_ORG_INSTRUCTIONS: Readonly<Record<CoreInstructionRole, string>> = {
  main: [
    'Do not do task work yourself. Hand each piece of work on: task_send to the task that owns its deliverable, task_create for new work, or org_send to the VP (lead) of its project.',
    'That includes every investigation, script, build, review and test, on a device too.',
    'Your work is deciding who does what, handing it over clearly, following up, and telling the user what needs them.',
    'Do only quick things yourself: one lookup, reading one record, passing on one message.',
  ].join('\n'),
  lead: [
    'Your teams do the work; you assign it, coordinate across teams and unblock them.',
    'Hand each deliverable to the task that owns it (task_send) or a new task (task_create); Walnut tells you when it moves.',
    'Do not build, test or investigate yourself beyond a quick look.',
  ].join('\n'),
};

/** The role's default, or '' for a task with no org role. */
export function defaultOrgInstructions(role: string | undefined): string {
  return role === 'main' || role === 'lead' ? DEFAULT_ORG_INSTRUCTIONS[role] : '';
}

const norm = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Words that are the role's default as it reads now (whitespace aside): no words of the user's. */
export function isDefaultOrgInstructions(role: string | undefined, text: string): boolean {
  const def = defaultOrgInstructions(role);
  return !!def && norm(text) === norm(def);
}

/**
 * The words the role's agent reads, as an editor's box shows them: the user's own words (or words an
 * agent wrote at the user's request); Walnut's default followed by an agent's added lines; or the
 * default alone. Saved back edited, the box is the user's words with the default still in them, so
 * fixing one word of an agent's line never drops the default unseen.
 */
export function orgInstructionsShown(role: string | undefined, stored?: { text?: string; by?: string; for_user?: boolean } | null): string {
  const def = defaultOrgInstructions(role);
  const text = (stored?.text ?? '').trim();
  if (!text) return def;
  const users = !stored?.by || stored.by === 'human' || stored.for_user === true;
  return users || !def ? text : `${def}\n\n${text}`;
}
