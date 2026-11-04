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

/**
 * The commands Main or a VP may run itself in one turn, only to look (2026-11-03, the user: "U never
 * never nver do it urslef unless it is under 3 command run ... this si the most improt rule, for a VP or
 * CEO"; a VP whose start was refused for a full slot ran the investigation itself instead). The first
 * line of both defaults, and what src/providers/org-work-guard-hook.ts counts: at this many in a turn
 * the agent is reminded to hand the work on, and never refused (2026-11-04, the user: "remove this
 * shodln;'t do this at all").
 */
export const ORG_SELF_COMMAND_LIMIT = 3;

/** 1st, 2nd, 3rd, 4th ... (English: the model reads it). */
export function ordinal(n: number): string {
  const t = n % 100;
  const suffix = t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** The rule as one line, the first of both defaults (also said when the user's own words replace them). */
/** How Main or a VP hands work on, in the words every reminder of the rule uses. */
export function orgHandOn(role: CoreInstructionRole): string {
  return role === 'main'
    ? 'task_send to the task that owns it, task_create for new work, or org_send to the VP of its project'
    : 'task_send to the team that owns it, or task_create for new work';
}

/**
 * The rule as the `hand-on` message hint says it (core/hints/hint-registry.ts): at a session's start,
 * after a compaction and every few messages, so it is in front of the node when it would forget
 * (2026-11-03, the user: "it shudo use prompt and in correct time to avoid forget, some instruction
 * eaach compation or at start some ever xround"). Short: it rides a message.
 */
export function orgHandOnHint(role: CoreInstructionRole): string {
  const who = role === 'main' ? 'Main' : 'a VP';
  return `you are ${who}: never do the work yourself. Run at most ${ORG_SELF_COMMAND_LIMIT} commands of your own in a turn, only to look, `
    + `then hand the rest on: ${orgHandOn(role)} (Walnut's own ops do not count; host_exec does).`;
}

export function orgSelfWorkRule(role: CoreInstructionRole): string {
  const handOn = orgHandOn(role);
  return `Never do the work yourself: run at most ${ORG_SELF_COMMAND_LIMIT} commands of your own in a turn, and only to look. `
    + `Past that, hand it to your team: ${handOn}, with what you saw so far in the hand-over. A full slot is no reason to do it `
    + `yourself: the start is queued and Walnut starts it when a slot frees. Walnut reminds you at your ${ordinal(ORG_SELF_COMMAND_LIMIT)} command `
    + '(Walnut\'s own ops do not count; host_exec does).';
}

export const DEFAULT_ORG_INSTRUCTIONS: Readonly<Record<CoreInstructionRole, string>> = {
  main: [
    orgSelfWorkRule('main'),
    'Do not do task work yourself. Hand each piece of work on: task_send to the task that owns its deliverable, task_create for new work, or org_send to the VP (lead) of its project.',
    'That includes every investigation, script, build, review and test, on a device too.',
    'Your work is deciding who does what, handing it over clearly, following up, and telling the user what needs them.',
    'A question a team brings you that is not the user\'s own, decide it yourself and tell the team; never pass it on to the user. Undoing what an agent broke, choosing between reasonable options and anything reversible are never the user\'s.',
    'The user\'s own are an outward message or post, spending, credentials, permissions, deleting cloud resources or data, a hard-to-reverse choice no rule covers, and a fact only they have. When you bring them one, say which kind it is (Walnut refuses a decision letter or a thread waiting on them that does not).',
  ].join('\n'),
  lead: [
    orgSelfWorkRule('lead'),
    'Your teams do the work; you assign it, coordinate across teams and unblock them.',
    'Hand each deliverable to the task that owns it (task_send) or a new task (task_create); Walnut tells you when it moves.',
    'A question a team brings you, decide it yourself and tell the team, however weighty it feels; being unsure is no reason to pass it up. Only the user\'s own go to them: an outward message or post, spending, credentials, permissions, deleting cloud resources or data, a hard-to-reverse choice no rule covers, and a fact only they have. Undoing what an agent broke, choosing between reasonable options and anything reversible are never theirs.',
    'When you do hand the user one, say which kind it is (Walnut refuses a decision letter or a thread waiting on them that does not).',
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
