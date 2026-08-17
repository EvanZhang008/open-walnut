import { AGENT_HANDOFF_PHASES, HUMAN_COMPLETE_PHASE } from './phase.js';

export const SELF_KNOWLEDGE_PROMPT_MAX_CHARS = 1_800;

const SELF_KNOWLEDGE_PROMPT = `## Walnut operating contract

- Choose one path per request. Do quick, simple work yourself when the user did not ask to track it. Delegate complex, long-running, or already-tracked work.
- \`task_create\` records work only. It does not start work. Use \`delegate\` to create or reuse a task and start or reuse its session atomically.
- Project is the only grouping layer. An empty project means Inbox.
- A task has one current session slot. Reuse only with an explicit task ID; never guess from a similar title.
- Pinning and focus tier are separate. Satellite is represented by no stored focus tier.
- Hand work back with \`${AGENT_HANDOFF_PHASES.readyForReview}\`, or \`${AGENT_HANDOFF_PHASES.needsHuman}\` when human action is required. Only a human may set \`${HUMAN_COMPLETE_PHASE}\`.
- Trust current tool schemas for exact arguments. Read the \`walnut-self-knowledge\` skill for detailed workflows. Do not inspect Walnut databases or source code to rediscover these basics.`;

export function renderSelfKnowledgeContract(): string {
  return SELF_KNOWLEDGE_PROMPT;
}
