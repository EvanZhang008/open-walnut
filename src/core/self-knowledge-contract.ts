import { PHASE_ORDER } from './phase.js';
import type { TaskPhase } from './types.js';
import { TEAM_CHARTER } from './team-charter.js';
import { WORK_PLACE_RULE } from './work-place.js';
import { TASK_ROUTING_CONTRACT } from './task-routing-contract.js';

// Budget for the whole bootstrap prompt. Raised from 1,800 when the task board
// model joined it (2026-08-26): the tiers decide where every created task lands,
// so the Main Agent has to know them before its first tool call. Anything that
// is not needed to make that first call belongs in the walnut-self-knowledge
// skill instead.
//
// Raised again to 2,050 on 2026-09-01 for "no `status`": the field was removed
// from every tool that day, so an agent that still assumes it exists writes a
// filter or a patch that no longer resolves. That is a first-tool-call fact by
// the same test as the tiers, which is why it earns bootstrap space instead of
// living in the skill.
//
// Raised to 2,200 on 2026-09-23 for placement: folders became a layer agents
// file into (a task created from inside another lands in its project AND
// folder), and "project is the only grouping layer" was now false. An agent
// that believes it names a project on every create and files work away from
// where the user put the caller, which is a first-tool-call mistake.
//
// Raised to 4,850 on 2026-10-24 for the team charter (team-charter.ts): who
// decides (the task doing the work), when to escalate, what each role does and
// when a message is worth sending. The Personal AI acts on it from its first
// turn. It renders 4,713 characters with it; the cap keeps a small margin
// above that, not room for more.
//
// Raised to 6,850 the same day for the task routing rules (task-routing-contract.ts):
// the dispatcher decides new task vs continue on its first call, and the same text
// rides the Main and lead prompts. It renders 6,687 characters with both.
//
// Raised to 7,900 on 2026-10-25 for where work lives (work-place.ts): a restart
// emptied /tmp and took clones, an unmerged commit and evidence with it, so where
// a clone or a report goes is decided before the first command that makes one.
// It renders 7,726 characters with it.
//
// Raised to 8,100 on 2026-10-27 for the charter's relay rule (team-charter.ts): Main
// passed on the user's request in its own words, narrowed it, and a worker shipped the
// narrowed version, so a relay now quotes the user first.
//
// Raised to 8,300 on 2026-10-29 for the charter's bug line: three bugs reported fixed
// came back the same day, each checked on another build and fixed for the one case
// seen. It renders 8,246 characters with it.
export const SELF_KNOWLEDGE_PROMPT_MAX_CHARS = 8_300;

// The phase LIST comes from PHASE_ORDER, so adding or removing a phase updates
// this prompt with no second edit. The phases the prompt names are typed
// as TaskPhase, so a rename in types.ts breaks the build here instead of
// silently teaching the Main Agent a phase that no longer exists.
// (WAIT removed 2026-08-18; WAITING, a parked task that any new message brings back, added 2026-09-30.)
const READY_PHASE: TaskPhase = 'NEED_ACTION';
const DONE_PHASE: TaskPhase = 'COMPLETE';

const SELF_KNOWLEDGE_PROMPT = `## Walnut operating contract

- Do quick, simple work yourself when the user did not ask to track it; track and start what they asked for.
- The task IS the work. \`task_create\` creates AND starts it; \`record_only: true\` saves a placeholder that runs nothing. \`task_start\` starts an existing task, \`task_send\` adds context or a question, \`task_history\` reads its conversation. Results come back by default; \`expect_reply: false\` opts out.
- Start work only on the user's ask. Follow-ups you find are yours to do here, never new tasks.
- An accepted start is not finished work. A start that errors keeps the task: fix the cause, then \`task_start\` that id; never a second \`task_create\`.
- Grouping is project, then folder inside it; an empty project means Inbox. A task created from inside another lands in its project and folder unless you name another project.
- A task holds one conversation. Reuse only with an explicit task ID and the same deliverable; never guess from a similar title.
- Phase is the ONE state field (no \`status\`): ${PHASE_ORDER.join(', ')}. Set \`${READY_PHASE}\` when your work is ready to look at and \`${DONE_PHASE}\` when it is finished. \`WAITING\` parks it until something happens; any new message brings it back (never the main agent's task: it stays active). Never for the user's move: that is \`${READY_PHASE}\`. You may set any phase; none is reserved. \`execution\` on a read observes the run; you never set it.
- When you mention a task, render \`<task-ref id="..." label="..."/>\` for a clickable pill: never a bare id, a markdown link, or a URL. Write tools return the exact tag in \`ref\` — paste it verbatim; otherwise build it from the id and title.
- Trust current tool schemas for arguments; the \`walnut-self-knowledge\` skill has the workflows. Do not read Walnut databases or source for these basics.

## Task board model

- Pinned is the active working set. Pinning and focus tier are separate.
- Focus: today's laser focus. Satellite: the default for a new task, and Satellite is represented by no stored focus tier.
- Parked (tier \`wait\`): set aside for now, someday work or work waiting on something.
- Unpinned: not due within a month; search brings it back.
- Create tasks in Satellite and groom the tier later; do not leave new work off the board.

${WORK_PLACE_RULE}

${TEAM_CHARTER}`;

export function renderSelfKnowledgeContract(): string {
  return `${SELF_KNOWLEDGE_PROMPT}\n\n${TASK_ROUTING_CONTRACT}`;
}
