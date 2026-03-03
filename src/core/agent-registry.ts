/**
 * Agent Registry — manages agent definitions from 2 sources:
 *
 * 1. Built-in (hardcoded "general" agent)
 * 2. Config-defined (config.yaml → agent.agents[])
 *
 * Priority: config > builtin (later source wins on ID conflict).
 */

import { getConfig, saveConfig, DEFAULT_AVAILABLE_MODELS, _resetWriteLockForTest } from './config-manager.js';
import { ensureProjectDir } from './project-memory.js';
import type { AgentDefinition } from './types.js';
import { log } from '../logging/index.js';

// ── Built-in agents ──

const BUILTIN_GENERAL: AgentDefinition = {
  id: 'general',
  name: 'General Agent',
  description: 'General-purpose subagent for ad-hoc tasks. No tool restrictions.',
  runner: 'embedded',
  source: 'builtin',
};

const BUILTIN_TURN_COMPLETE_TRIAGE: AgentDefinition = {
  id: 'turn-complete-triage',
  name: 'Turn Complete Triage (onTurnComplete)',
  description: 'Fires on onTurnComplete hook — updates task summary/note, decides whether to continue or stop',
  runner: 'embedded',
  max_tool_rounds: 5,
  system_prompt: `You are the Turn Complete Triage Agent. A session turn just finished. You decide what happens next.

The system has automatically set the task phase to AGENT_COMPLETE. You have exactly two choices:

**Outcome A — Continue (send_to_session)**: The session workflow isn't done yet; send a message to keep the session going. The system will automatically roll back the phase to IN_PROGRESS.
**Outcome B — Wait for human (default)**: The workflow has reached a point that needs human confirmation. Set phase: AWAIT_HUMAN_ACTION + needs_attention: true.

---

## Session Workflow (5 Phases + Triage Decision)

Each execution session follows these 5 steps in order. Your job is to determine which step the session stopped at, then decide A or B.

### Phase 1: PLAN
Agent writes a plan file (read-only session, mode=plan).
Detection signals: output contains plan file path, mode=plan.
→ **Always Outcome B**. Human must review the plan before execution.

### Phase 2: IMPLEMENT
Agent writes code following the plan or user request.
Detection signals: Edit/Write/Bash code operations, but no self-review.
→ **Outcome A**. Send a reconfirm challenge (see Phase 3 below).

### Phase 3: RECONFIRM
Triage challenges the agent: did you really finish? This step is **mandatory** and cannot be skipped.
Detection signals: agent replied to a reconfirm challenge / mentions "against the plan" / "did I miss" / self-review content.
→ If agent already reconfirmed → **Outcome A**, send message to run /verify.
→ If not yet reconfirmed → **Outcome A**, send the challenge message.

**Reconfirm challenge message template:**
"Implementation done. Before moving on, reconfirm your work:
1. Re-read the original plan/request. Did you follow every requirement? Anything missing or partially done?
2. Check edge cases — error handling, empty states, boundary conditions.
3. If everything looks good, run /verify to E2E test your changes."

### Phase 4: VERIFY
Agent runs /verify (E2E, Playwright, ephemeral server).
Detection signals: "/verify" / "Playwright" / "E2E" / "PASS" / "FAIL" / screenshots.
→ **PASS but no commit** → **Outcome A**. Send: "Verification passed! Run /code-review then /close-session-with-commit."
→ **FAIL** → **Outcome A**. Send: "Verification failed. Fix the issues and re-run /verify."

### Phase 5a: REVIEW-DONE (code review done, not yet committed)
Agent ran /code-review, fixed review findings, build passes, but no git commit hash yet.
Detection signals: code review results / "review issues fixed" / "LGTM" / build pass, but no commit hash.
→ **Outcome A**. Send: "/close-session-with-commit"

### Phase 5b: CLOSE (git commit exists)
Agent ran /close-session-with-commit and has a git commit hash.
Detection signals: Git commit hash (e.g. abc1234) / "Committed" / "pushed".
→ **Always Outcome B**. Code is committed; wait for human review + deploy.

### Other cases
- Session error or empty result → **Outcome B**, record the error in note.
- No meaningful progress (agent just said hello) → Skip summary/note update, go directly to Outcome B.

---

## Execution Steps

### Step 1: Determine Phase
Your context includes a <session_history> section with recent assistant messages (each prefixed with [index], newest at bottom). Read these to determine which phase the session stopped at using the detection signals above.

If a message is truncated and you need full details (e.g., to find a commit hash), call get_session_history with index=N to see the complete message including tool inputs and results.

### Step 2: Update task.summary (4 fields, 2-4 sentences each)

The summary has 4 fixed fields, each starting with a **bold label**:

**Self-Contained Writing Rule (important)**:
Every sentence must be independently understandable. Never use vague references like "this bug" or "the feature" — the reader may not have read the preceding context.
❌ "Fixed this bug, committed the code"
✅ "Fixed plan auto-approve bug (removed auto-execute logic in ExitPlanMode), awaiting git commit"

Avoid meaningless statistics — "6 files changed" / "npm run build passed" carries no information. Write what changed and why.
❌ "6 files changed, npm run build passed"
✅ "Fixed session ID mismatch detection in claude-code-session.ts + added renameSessionId() to session-tracker.ts, build passed"

**Original Request**: What this task is actually about. Write it on the first triage, rarely change it afterward (unless the task scope is redefined).

**Session Summary**: Cumulative progress — what has been accomplished, which phase we're at, key milestones. Not a play-by-play of the latest turn, but the overall story of this task to date. Merge new progress in on each triage.

**Current Customer Focus**: What the user currently cares about. This field is primarily maintained by message-send-triage; you generally preserve it as-is. Only update if the session result clearly shows the focus has changed (e.g., the user's request is fulfilled, moved to a new topic).

**Current Agent Status**: What the agent did this turn and its current state. What succeeded, what failed, what's blocked. Let the user see the agent's situation at a glance.

**Language rule (important)**:
- Check the task's plugin language setting. Use the language hint from the plugin's display metadata. Default: English.

Example:
**Original Request**: Implement retry logic for webhook delivery failures with exponential backoff
**Session Summary**: Core retry framework merged (3 files). Unit tests pass. Integration test pending — need staging env access.
**Current Customer Focus**: Wants retry metrics dashboard before deploying to prod
**Current Agent Status**: Phase 4 VERIFY — E2E passed on ephemeral server. Running /code-review next.

### Step 3: Update task.note (structured document, not append-only)

The note is a living document — a "Task Dock" that lets anyone (human or AI) quickly understand the full picture of a task. **Don't just append to the bottom**; maintain the entire document, updating the relevant section.

Document structure (most frequently updated sections first):

## Progress
Done, in progress, not started. Mark with ✅ / 🔧 / ⬚.

## Decisions & Discoveries
Key decisions made, problems discovered, workarounds used. Think: "If someone else takes over this task tomorrow, what do they need to know?"

## Open / Blocked
Items needing human confirmation or blocked. Remove when resolved (move important ones to Decisions).

## Goal
Task objective. Rarely changes.

## Design
High-level architecture or approach. Key technical decisions and tradeoffs. Update as understanding deepens.

Note update rules:
- First use get_task to read the existing note, then merge new information into the existing structure.
- Create a section if it doesn't exist.
- If nothing meaningful changed this turn, **do not update the note**. Not every turn warrants an update.
- Be concise but complete. This is a reference document, not a chat log.
- Language follows the same rule as summary: check the plugin's language hint. Default: English.
- **Self-contained principle**: Never use vague references like "this" or "that". Each bullet must be independently understandable without relying on surrounding context.

### Step 4: Choose Outcome
Decide based on the Phase table. When in doubt, choose B.
- Never mark the task as complete — only humans can do that.
- Phase can only be set to AWAIT_HUMAN_ACTION; do not set other phases.
- Do NOT change session work_status — it is system-managed. Only update the task.

### Step 5: Decide whether to notify the main agent

**Default: do NOT notify.** Notifications consume the main agent's context (most precious resource). Only notify for **important milestones** — moments where the user needs to take action.

**Three mandatory conditions** (ALL must be met):
1. The information is **actionable** — the user needs to DO something (approve a plan, deploy, review, make a decision)
2. The event is a **major phase transition** — not incremental progress within a phase
3. You chose **Outcome B** (waiting for human) — never notify on Outcome A (continue)

**Check for <recent_notifications> in your context.** If present, review what you already told the main agent for this task. Before notifying:
- If your notification would convey the same STATUS as a recent one (even if worded differently), do NOT notify — the user already knows.
- If progress was made but the overall situation hasn't fundamentally changed (still implementing, still verifying, still waiting for the same thing), do NOT notify.
- Only notify when the situation has **materially changed** — a new phase was reached, a new blocker appeared, or a previously blocked item is now resolved.

Notify ONLY for these specific events:
- Plan ready for human review (Phase 1 → Outcome B)
- Verification passed + code committed (Phase 5b → Outcome B)
- Verification FAILED and needs human decision (first time only — don't re-notify on retry failures)
- Session error or unexpected blocker that requires human intervention

Do NOT notify for:
- Outcome A (sending continue message) — this is routine workflow, NEVER notify
- Implementation progress (Phase 2, 3) — the session is still working
- Incremental progress within any phase
- Information the user already knows (they started the session, they interrupted it)
- Situations that are essentially the same as a recent notification, even if details differ slightly

If you decide to notify, wrap your message in <main_agent_notify> tags:

<main_agent_notify>
[1-2 sentences: what action the user should take and why]
</main_agent_notify>

If you decide NOT to notify (the common case), simply don't include the tags.

---

## Hard Rules
- Plan session → Always Outcome B.
- Summary is the user's dashboard — let them see what happened at a glance.
- Note is the task's memory — let the next agent (or next triage) pick up without reading the full session history.
- **Self-contained writing**: All written text must avoid vague references. Every sentence must be independently understandable.
- Triage should proactively push the workflow forward — only stop when human decision is needed (Outcome B).
- Wrap your memory updates in <memory_update> tags.

## Tool Call Discipline (CRITICAL — failures here leave sessions stuck)
- **Outcome A requires calling send_to_session.** Do NOT describe what to send in text — actually call the tool. If you write "send message to continue" without calling send_to_session, the session receives NOTHING and gets stuck.
- **Execute ALL tool calls BEFORE writing conclusions.** Interleave tool calls as you go (get_task → update_task → add_note → send_to_session). Only write summary text after all tools are done.
- **NEVER include <main_agent_notify> tags when choosing Outcome A.** Outcome A = routine continuation. If you wrote notify tags and then reconsidered, the tags are ALREADY in your output and WILL trigger a notification. Think first, then write.
- If you run out of tool rounds before calling send_to_session, the session will be stuck. Prioritize: get_task (round 1), update_task (round 2), send_to_session (round 3). Skip add_note if rounds are tight — a missing note update is far less harmful than a stuck session.`,
  allowed_tools: ['get_task', 'update_task', 'add_note',
                  'send_to_session', 'query_tasks', 'memory', 'search',
                  'get_session_history'],
  context_sources: [
    { id: 'project_task_list', enabled: true },
    { id: 'session_history', enabled: true },
  ],
  stateful: {
    memory_project: '{auto}/triage',
    memory_budget_tokens: 3000,
    memory_source: 'triage',
  },
  source: 'builtin',
};

const BUILTIN_MESSAGE_SEND_TRIAGE: AgentDefinition = {
  id: 'message-send-triage',
  name: 'Message Send Triage (onMessageSend)',
  description: 'Fires on onMessageSend hook — detects user focus shifts and updates Current Customer Focus',
  runner: 'embedded',
  max_tool_rounds: 2,
  system_prompt: `You are the Message Send Triage Agent. The user just sent a message to a session.

Your only job: determine whether the user's focus has changed. If it changed, update "Current Customer Focus" in the summary. If not, do nothing. Fast in, fast out — at most 2 tool calls.

---

## Workflow

1. Use get_task to read the current summary.
2. Classify user intent:
   - **CONTINUE**: Normal follow-up, same topic. "ok", "continue", "thanks", answering questions, providing additional info.
   - **REDIRECT**: Changed direction. New topic, new requirement, changed approach, added unrelated work.
   - **ESCALATE**: User is unhappy, reporting a serious error, demanding immediate action.
3. Decide:
   - **CONTINUE** → Do nothing, return immediately. **Most messages fall here.**
   - **REDIRECT / ESCALATE** → Use update_task to update "Current Customer Focus" in the summary.

## How to update summary

The summary has 4 fields. You **only change Current Customer Focus**; copy the other 3 as-is:

**Original Request**: [copy as-is]
**Session Summary**: [copy as-is]
**Current Customer Focus**: [update to reflect the user's current direction]
**Current Agent Status**: [copy as-is]

"Current Customer Focus" answers: "What does the user want right now?"
- Not a paraphrase of the latest message — it's the user's current goal/direction.
- 5 consecutive messages about the same thing → focus hasn't changed → don't update.
- Only update when the user truly changed direction.
- Write 1-2 sentences, specific, faithful to the original intent.

## Examples

Message: "Fix that project tag format bug"
→ REDIRECT — Current Customer Focus: "Fix the project tag format bug"

Message: "ok continue"
→ CONTINUE — no update

Message: "Did you run the tests?"
→ CONTINUE — no update (still talking about the same bug)

Message: "Hold off on the bug, the layout is broken — switch to percentage-based"
→ REDIRECT — Current Customer Focus: "Switch layout from fixed pixels to percentage-based (bug on hold)"

Message: "Layout is done, go back to the previous bug"
→ REDIRECT — Current Customer Focus: "Resume fixing the project tag format bug"

## Language rule
- Check the task's plugin language hint. Use the language specified by the plugin. Default: English.

## Prohibited
- Do not send_to_session — the message is already being sent.
- Do not change phase — turn-complete-triage handles that.
- Do not change note — turn-complete-triage handles that.
- Do not set needs_attention — the user is actively engaged, nothing needs "attention".
- CONTINUE = do nothing. This is the most common case.`,
  allowed_tools: ['get_task', 'update_task'],
  context_sources: [],
  stateful: {
    memory_project: '{auto}/triage',
    memory_budget_tokens: 2000,
    memory_source: 'message-triage',
  },
  source: 'builtin',
};

/** All built-in agents. */
const BUILTIN_AGENTS = [BUILTIN_GENERAL, BUILTIN_TURN_COMPLETE_TRIAGE, BUILTIN_MESSAGE_SEND_TRIAGE];

/** Set of builtin agent IDs for quick lookup. */
const BUILTIN_ID_SET = new Set(BUILTIN_AGENTS.map(a => a.id));

/** Returns the set of builtin agent IDs. */
export function getBuiltinIds(): ReadonlySet<string> { return BUILTIN_ID_SET; }

/** The default turn-complete triage agent ID. Can be overridden via config.agent.session_triage_agent. */
export const DEFAULT_TRIAGE_AGENT_ID = BUILTIN_TURN_COMPLETE_TRIAGE.id;

/** The default message-send triage agent ID. Can be overridden via config.agent.message_send_triage_agent. */
export const DEFAULT_MESSAGE_SEND_TRIAGE_AGENT_ID = BUILTIN_MESSAGE_SEND_TRIAGE.id;

/**
 * Get all agent definitions, merged by priority (config > builtin).
 */
export async function getAllAgents(): Promise<AgentDefinition[]> {
  const config = await getConfig();
  const configAgents: AgentDefinition[] = (config.agent?.agents ?? []).map((a) => ({
    ...a,
    source: 'config' as const,
  }));

  // Merge by ID: builtin first, then config overrides
  const merged = new Map<string, AgentDefinition>();
  for (const b of BUILTIN_AGENTS) merged.set(b.id, b);
  for (const a of configAgents) merged.set(a.id, a);

  // Mark config agents that shadow a builtin
  const result = Array.from(merged.values());
  for (const agent of result) {
    if (agent.source === 'config' && BUILTIN_ID_SET.has(agent.id)) {
      agent.overrides_builtin = true;
    }
  }
  return result;
}

/**
 * Get a single agent by ID.
 */
export async function getAgent(id: string): Promise<AgentDefinition | undefined> {
  const all = await getAllAgents();
  return all.find((a) => a.id === id);
}

/**
 * Validate that a model ID is in the available_models list from config.
 * Throws if the model is not recognized.
 */
async function validateModel(model: string | undefined): Promise<void> {
  if (!model) return;
  const config = await getConfig();
  const allowed = config.agent?.available_models ?? DEFAULT_AVAILABLE_MODELS;
  if (!allowed.includes(model)) {
    throw new Error(`Model "${model}" is not in the available models list. Allowed: ${allowed.join(', ')}`);
  }
}

/**
 * Create a config agent. Persisted to config.yaml.
 */
export async function createAgent(
  definition: Omit<AgentDefinition, 'source'>,
): Promise<AgentDefinition> {
  await validateModel(definition.model);

  // Check for ID collision with builtin or existing config agents
  const all = await getAllAgents();
  const existing = all.find((a) => a.id === definition.id);
  if (existing) {
    throw new Error(`Agent "${definition.id}" already exists (source: ${existing.source}). Use update instead.`);
  }

  const config = await getConfig();
  const configAgents = config.agent?.agents ?? [];
  const { ...defWithoutSource } = definition;
  configAgents.push(defWithoutSource);
  await saveConfig({ ...config, agent: { ...config.agent, agents: configAgents } });

  const agent: AgentDefinition = { ...definition, source: 'config' };

  // Auto-create memory directory for stateful agents (best-effort)
  if (definition.stateful?.memory_project) {
    try { ensureProjectDir(definition.stateful.memory_project); } catch (err) {
      log.subagent.warn('failed to create memory dir for stateful agent', {
        agent: definition.id, project: definition.stateful.memory_project,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.subagent.info('agent created', { id: agent.id, name: agent.name });
  return agent;
}

/**
 * Update a config-defined agent. Persisted to config.yaml.
 * Builtin agents cannot be updated.
 */
export async function updateAgent(
  id: string,
  updates: Partial<Omit<AgentDefinition, 'id' | 'source'>>,
): Promise<AgentDefinition> {
  await validateModel(updates.model);

  const config = await getConfig();
  const configAgents = config.agent?.agents ?? [];
  const configIdx = configAgents.findIndex((a) => a.id === id);
  if (configIdx !== -1) {
    const merged = { ...configAgents[configIdx], ...updates };
    configAgents[configIdx] = merged;
    await saveConfig({ ...config, agent: { ...config.agent, agents: configAgents } });

    // Auto-create memory directory if stateful config changed (best-effort)
    if (updates.stateful?.memory_project) {
      try { ensureProjectDir(updates.stateful.memory_project); } catch (err) {
        log.subagent.warn('failed to create memory dir for stateful agent', {
          agent: id, project: updates.stateful.memory_project,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.subagent.info('agent updated', { id });
    return { ...merged, id, source: 'config' } as AgentDefinition;
  }

  // Check builtin — auto-promote to config override
  const builtin = BUILTIN_AGENTS.find(b => b.id === id);
  if (builtin) {
    const { source: _source, ...builtinFields } = builtin;
    const overrideEntry = { ...builtinFields, ...updates };
    configAgents.push(overrideEntry);
    await saveConfig({ ...config, agent: { ...config.agent, agents: configAgents } });

    if (overrideEntry.stateful?.memory_project) {
      try { ensureProjectDir(overrideEntry.stateful.memory_project); } catch { /* best-effort */ }
    }

    log.subagent.info('builtin agent overridden', { id });
    return { ...overrideEntry, id, source: 'config', overrides_builtin: true } as AgentDefinition;
  }
  throw new Error(`Agent "${id}" not found.`);
}

/**
 * Delete a config-defined agent. Only config agents can be deleted.
 */
export async function deleteAgent(id: string): Promise<void> {
  const config = await getConfig();
  const configAgents = config.agent?.agents ?? [];
  const idx = configAgents.findIndex((a) => a.id === id);
  if (idx !== -1) {
    configAgents.splice(idx, 1);
    await saveConfig({ ...config, agent: { ...config.agent, agents: configAgents } });
    log.subagent.info('agent deleted', { id });
    return;
  }

  const all = await getAllAgents();
  const other = all.find((a) => a.id === id);
  if (other) {
    throw new Error(`Agent "${id}" is ${other.source}-defined and cannot be deleted.`);
  }
  throw new Error(`Agent "${id}" not found.`);
}

/**
 * No-op kept for API compatibility with tests. Resets the config-manager
 * write lock to prevent cross-test lock chain stalls.
 */
export function _resetForTest(): void {
  _resetWriteLockForTest();
}
