import { PHASE_ORDER } from './phase.js';
import type { TaskPhase } from './types.js';

export const SELF_KNOWLEDGE_PROMPT_MAX_CHARS = 1_800;

// The phase LIST comes from PHASE_ORDER, so adding or removing a phase updates
// this prompt with no second edit. The phases the prompt names are typed
// as TaskPhase, so a rename in types.ts breaks the build here instead of
// silently teaching the Main Agent a phase that no longer exists.
// (WAIT removed 2026-08-18: a blocked task is just TODO — no separate phase.)
const READY_PHASE: TaskPhase = 'AGENT_COMPLETE';
const DONE_PHASE: TaskPhase = 'COMPLETE';

const SELF_KNOWLEDGE_PROMPT = `## Walnut operating contract

- Choose one path per request. Do quick, simple work yourself when the user did not ask to track it. Delegate complex, long-running, or already-tracked work.
- \`task_create\` records work only. It does not start work. Use \`delegate\` to create or reuse a task and start or reuse its session atomically.
- Project is the only grouping layer. An empty project means Inbox.
- A task has one current session slot. Reuse only with an explicit task ID; never guess from a similar title.
- Pinning and focus tier are separate. Satellite is represented by no stored focus tier.
- Task phases are ${PHASE_ORDER.join(', ')}. Set \`${READY_PHASE}\` when your work is ready to look at and \`${DONE_PHASE}\` when it is finished. A blocked or parked task is just TODO. You may set any phase; none is reserved.
- When you mention a task or session to the user, render it as \`<task-ref id="..." label="..."/>\` (or \`<session-ref .../>\`) so the UI shows a clickable pill. This is the ONLY correct form: never a bare id, a markdown link, or a localhost URL. Task-mutating tools return the exact tag in a \`ref\` field — paste it verbatim; for read-only tools, build the tag from the returned id and title.
- Trust current tool schemas for exact arguments. Read the \`walnut-self-knowledge\` skill for detailed workflows. Do not inspect Walnut databases or source code to rediscover these basics.`;

export function renderSelfKnowledgeContract(): string {
  return SELF_KNOWLEDGE_PROMPT;
}
