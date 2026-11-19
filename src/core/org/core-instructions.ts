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
  // 2026-11-19: the source-check rule rides here too, so it is in front of the node when it writes to the user.
  return `at most ${ORG_SELF_COMMAND_LIMIT} commands of your own a turn, only to look; hand the rest to your team. `
    + 'Tell the user as fact only what you checked; else say whose word it is.';
}

export function orgSelfWorkRule(role: CoreInstructionRole): string {
  const handOn = orgHandOn(role);
  return `Never do the work yourself: run at most ${ORG_SELF_COMMAND_LIMIT} commands of your own in a turn, and only to look. `
    + `Past that, hand it to your team: ${handOn}, with what you saw so far in the hand-over. A full slot is no reason to do it `
    + `yourself: a start with no named host or folder waits for a free slot and starts by itself. Do not retry it. Explicit host or folder constraints still fail with 409 hosts_full. Walnut reminds you at your ${ordinal(ORG_SELF_COMMAND_LIMIT)} command `
    + '(Walnut\'s own ops do not count; host_exec does). '
    + 'A question the user asks you directly (explain, check, "are you sure?") is yours to answer: look with your own read-only '
    + 'subagent (Agent tool, subagent_type Explore), which does not count toward the limit, and never pass the question to a '
    + 'worker; only a change to a deliverable goes to its owner.';
}

/**
 * Hand work by deliverable, never by component (2026-11-16, the user: a VP's most important job is to understand which
 * task a piece of work belongs to, and to create one when none owns it): a lead gave a new incident's fix to an open task that owned an
 * older code review in the same file, and another merged a website launch into a logo redesign's task. The steps (search several ways,
 * read the candidates' deliverable, first request and latest report, decide by meaning) are the task routing contract's, which every
 * session reads; this line makes them the dispatcher's main job. No check matches numbers or formats in a message (2026-11-17, the user:
 * "not generic"); the tools put each candidate's deliverable in front of the sender instead (task-deliverable.ts).
 */
export const DELIVERABLE_CHECK_RULE =
  'Finding the owner is your main job: for every hand-off (the user\'s follow-ups, a worker\'s report, an alert) follow the task routing '
  + 'steps (search several ways, read the candidates\' deliverable, first request and latest report, decide by meaning); an '
  + 'owner someone else names is a candidate too. A finished task whose delivered work came back, whose watch '
  + 'fired, or that led the last round of a recurring duty (an on-call week) is its owner (task_send force with a reason). The same package, component, file, place or person is no reason; when no task '
  + 'owns it, task_create. One issue is one task: hand an issue\'s next step (a fix, a second change, a comment, a reply) to the task '
  + 'that holds it and let it fan out on its own, never a sibling task per step. Two issues in one '
  + 'message of the user are two tasks.'

/**
 * A team's conclusion is its claim, never a fact the node may pass on as its own (2026-11-17, Main's decision after four VPs did
 * it on one day: one relayed a worker's plan that was wrong three times, one wrote an adviser's suggestion as a provider's rule, one
 * passed on a cause nobody had checked, one called a risk "bigger than you think" and took it back). Words only, no check in code
 * (the user: "Mostly prompt instruction, not ... hard code some rule by code").
 *
 * 2026-11-19, seven more misses on 11-18 with the rule in every VP's context, read from their own sessions: the caveat was written
 * in chat (34 of 127 replies of one VP) and almost never in a Brief (0 of 50), a thread summary (5 of 77) or a letter, which the user
 * reads without the chat; the claims were a Walnut status line ("no longer needs him" for a task that only went back to Working,
 * "Waiting" for a stale display string), a test result with no commit, two sources merged into one, an "ask them to confirm" turned
 * into a fact, and the VP's own memory of how a ticket state behaves. Each is named below, and WORD_TO_USER_RULE (thread-rules.ts) says it
 * again in the tools that write to the user.
 */
export const SOURCE_CHECK_RULE =
  'Tell the user as fact only what you checked at its source yourself. Until then these are claims: a team\'s conclusion (a cause, '
  + 'number, rule, plan, risk or "done"), a status label Walnut shows read as more than it says (it can lag the task), a test result, and your own memory of how something works. '
  + 'Say whose word it is and that you have not checked it, in your chat and just as much in a Brief, a thread summary or a letter. '
  + 'Keep each source\'s own words: never merge two sources into one, or make "ask them to confirm" a fact. A test result names the '
  + 'commit it ran on; a risk says who it hits and how much.';

/** Which decisions are the user's, as both defaults say it. */
const USER_KINDS_RULE =
  'Just the user\'s own go to them: an outward message or post, anything in their name or involving other people, spending, credentials, permissions, deleting cloud resources or data, '
  + 'a hard-to-reverse choice no rule covers, and a fact only they have; when you bring one, say which kind (Walnut checks). Undoing '
  + 'what an agent broke, choosing between reasonable options and anything reversible are never theirs.';

/** Deciding in the user's place what a task below asks them, as both defaults say it. */
const ANSWERS_ASK_RULE =
  'A question a task below you asks the user that you decide: send it with task_send answers_ask=true, which takes it off the '
  + 'user\'s Needs you and tells the task once; a note or your chat alone leaves it asking. An ask of the user\'s own kinds '
  + 'needs user_words quoting their yes: your decision is not it.';

export const DEFAULT_ORG_INSTRUCTIONS: Readonly<Record<CoreInstructionRole, string>> = {
  main: [
    orgSelfWorkRule('main'),
    'Do not do task work yourself. Hand each piece of work on, as above: every investigation, script, build, review and test, on a device too. '
      + 'Your job: who does what, a clear hand-over, follow-up, and telling the user what needs them.',
    DELIVERABLE_CHECK_RULE,
    SOURCE_CHECK_RULE,
    `A question a team brings you, decide it yourself and tell the team. ${USER_KINDS_RULE}`,
    ANSWERS_ASK_RULE,
  ].join('\n'),
  lead: [
    orgSelfWorkRule('lead'),
    'Your teams do the work; you assign it, coordinate across teams and unblock them, and Walnut tells you when a deliverable moves.',
    DELIVERABLE_CHECK_RULE,
    SOURCE_CHECK_RULE,
    `A question a team brings you, decide it yourself and tell the team, however weighty it feels; being unsure is no reason to pass it up. ${USER_KINDS_RULE}`,
    ANSWERS_ASK_RULE,
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
