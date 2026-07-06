/**
 * Agent tool: memory_manage
 * Bounded writes to the two always-injected memory stores (Hermes memory-tool parity):
 *   target 'memory' → memory/MEMORY.md — behavior rules ("always X", "never Y")
 *   target 'user'   → memory/USER.md   — who the user is (identity, work, preferences)
 *
 * Memory is a SEPARATE tool from skill_manage on purpose: memory is "who the
 * user is / how to behave" (injected every turn), skills are "how to do a class
 * of task" (loaded on demand). Merging them into one action enum blurred that
 * routing decision at the exact moment the model makes it.
 *
 * The schema description carries the triage rules (WHEN to save / what to SKIP)
 * so the model routes information correctly at write time.
 */
import type { ToolDefinition } from '../tools.js';
import {
  getBoundedMemory,
  MEMORY_CHAR_BUDGET,
  USER_CHAR_BUDGET,
} from '../../core/bounded-memory.js';
import type {
  BoundedMemoryOperation,
  BoundedMemoryResult,
  MemoryTarget,
} from '../../core/bounded-memory.js';
import { log } from '../../logging/index.js';

function renderResult(result: BoundedMemoryResult): string {
  if (!result.success && result.currentEntries) {
    // Over-budget / no-match paths: append the skill-routing hint so the model
    // considers moving content OUT of memory instead of endlessly compressing.
    return JSON.stringify(
      {
        ...result,
        hint:
          'If the content you are trying to save is domain knowledge or a reusable ' +
          'procedure (not a behavior rule or user-profile fact), do NOT keep it in memory — ' +
          'create or patch a skill instead (skill_manage; type: knowledge for facts, type: action for procedures).',
      },
      null,
      2,
    );
  }
  return JSON.stringify(result, null, 2);
}

// memory_manage always operates on the GENERAL global stores — the ones
// injected into every conversation. (Per-agent memory files keep their
// existing file_write/file_edit path.) The consolidation breaker — reset in
// loop.ts at main-turn boundaries — lives on these same store objects.
export const memoryManageTool: ToolDefinition = {
  name: 'memory_manage',
  description: `Manage your two always-injected memory stores. Entries are "## Title" markdown sections; both stores are injected into EVERY conversation — keep them small and high-signal.

## Targets (choose per fact)
- **user** (USER.md, hard budget ${USER_CHAR_BUDGET.toLocaleString('en-US')} chars): who the user IS — identity, role/work, family, durable preferences, communication style. Very tied to the person, stable across projects.
- **memory** (MEMORY.md, hard budget ${MEMORY_CHAR_BUDGET.toLocaleString('en-US')} chars): how YOU should behave — operating rules, workflow conventions, corrections turned into standing rules.
Rule of thumb: "the user prefers/is/works at X" → user; "when doing Y, always/never Z" → memory.

## WHEN to save
- The user states a preference, correction, or personal detail that should persist ("always X", "never Y", "I prefer Z", "I work on W").
- You learned a stable behavioral rule from feedback (e.g. repeated correction).
- Update EXISTING entries when facts change — use 'replace', never add a near-duplicate.
- Write declarative facts, not instructions to yourself: "User prefers concise responses" ✓ — "Always respond concisely" ✗.

## SKIP (route elsewhere — do NOT save here)
- Task progress, completed-work logs, anything stale in a week → nothing (history_search recalls it).
- Episodic events ("filed tax last week") → daily log (file_write memory/daily).
- Domain knowledge (facts about a system/project/topic) → knowledge skill (skill_manage, type: knowledge).
- Reusable procedures / how-tos → action skill (skill_manage, type: action).

## Actions
- add: append one new "## Title" entry.
- replace: find the entry containing old_text (substring), swap it for content.
- remove: delete the entry containing old_text (substring).
- batch: apply operations[] atomically — validated against the FINAL budget only, all-or-nothing. **Preferred whenever you make more than one change**: free space (remove/replace) AND add in ONE call.

## Budget behavior
If a write would exceed the target's budget, you get the full current entries back with instructions to consolidate (merge/shorten/remove) and retry — in THIS turn, ideally as a single batch. A success response is terminal: do not repeat the write.`,
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'replace', 'remove', 'batch'],
        description: 'The memory operation to perform.',
      },
      target: {
        type: 'string',
        enum: ['memory', 'user'],
        description:
          "Which store: 'user' = who the user is (identity, preferences); 'memory' = your behavior rules. Default: memory.",
      },
      content: {
        type: 'string',
        description:
          'For add/replace: the full new entry as a markdown section starting with "## Title". Keep entries short and declarative.',
      },
      old_text: {
        type: 'string',
        description:
          'For replace/remove: a substring uniquely identifying the target entry. If it matches multiple distinct entries you will be asked to be more specific.',
      },
      operations: {
        type: 'array',
        description:
          'For batch: ordered list of operations, applied atomically against the final budget (all-or-nothing).',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'replace', 'remove'] },
            content: { type: 'string', description: 'For add/replace: the new "## Title" entry.' },
            old_text: { type: 'string', description: 'For replace/remove: substring identifying the target entry.' },
          },
          required: ['action'],
        },
      },
    },
    required: ['action'],
  },
  async execute(params) {
    const action = params.action as string;
    const target: MemoryTarget = params.target === 'user' ? 'user' : 'memory';
    const store = getBoundedMemory(undefined, target);

    let result: BoundedMemoryResult;
    if (action === 'add') {
      result = await store.add((params.content as string) ?? '');
    } else if (action === 'replace') {
      result = await store.replace((params.old_text as string) ?? '', (params.content as string) ?? '');
    } else if (action === 'remove') {
      result = await store.remove((params.old_text as string) ?? '');
    } else if (action === 'batch') {
      const rawOps = (params.operations as Array<Record<string, unknown>> | undefined) ?? [];
      const ops: BoundedMemoryOperation[] = rawOps.map((op) => ({
        action: op.action as 'add' | 'replace' | 'remove',
        content: (op.content as string) ?? '',
        oldText: (op.old_text as string) ?? '',
      })) as BoundedMemoryOperation[];
      result = await store.applyBatch(ops);
    } else {
      return `Unknown action '${action}'. Use add, replace, remove, or batch.`;
    }

    log.agent.info('memory_manage executed', {
      action,
      target,
      success: result.success,
      ...(result.success ? { usage: result.usage } : { terminal: result.terminal ?? false }),
    });
    return renderResult(result);
  },
};
