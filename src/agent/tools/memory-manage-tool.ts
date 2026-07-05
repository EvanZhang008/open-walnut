/**
 * Agent tool: memory_manage
 * Bounded global MEMORY.md writes (add/replace/remove/batch) via bounded-memory.ts.
 *
 * The schema description carries the triage rules (WHEN to save / what to SKIP)
 * so the model routes information correctly at write time: behavior rules and
 * user preferences live here; episodic events go to the daily log; domain
 * knowledge and procedures go to skills.
 */
import type { ToolDefinition } from '../tools.js';
import { getBoundedMemory, MEMORY_CHAR_BUDGET } from '../../core/bounded-memory.js';
import type { BoundedMemoryOperation, BoundedMemoryResult } from '../../core/bounded-memory.js';
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
          'procedure (not a behavior rule or user preference), do NOT keep it in memory — ' +
          'create or patch a skill instead (type: knowledge for facts, type: action for procedures).',
      },
      null,
      2,
    );
  }
  return JSON.stringify(result, null, 2);
}

// memory_manage always operates on the GENERAL global MEMORY.md — the single
// store injected into every conversation. (Per-agent memory files keep their
// existing file_write/file_edit path.) A single store also keeps the
// consolidation breaker — reset in loop.ts at main-turn boundaries on the same
// general store — attached to the same object this tool mutates.
export const memoryManageTool: ToolDefinition = {
    name: 'memory_manage',
    description: `Manage the bounded global MEMORY.md (hard budget: ${MEMORY_CHAR_BUDGET.toLocaleString('en-US')} chars). Entries are "## Title" markdown sections. This memory is injected into EVERY conversation — keep it small and high-signal.

## WHEN to save (behavior rules + user preferences ONLY)
- The user states a preference, correction, or personal detail that should change how you behave from now on ("always X", "never Y", "I prefer Z").
- You learned a stable behavioral rule from feedback (e.g. repeated correction).
- Update EXISTING entries when facts change — use 'replace', never add a near-duplicate.

## SKIP (route elsewhere — do NOT save here)
- Trivial or one-off info, task progress, completed-work logs → nothing, or the daily log.
- Episodic events ("filed tax last week", "met with X") → daily log (file_write memory/daily).
- Domain knowledge (facts about a system, a project, a topic) → knowledge skill (skill_manage, type: knowledge).
- Reusable procedures / how-tos → action skill (skill_manage, type: action).

## Actions
- add: append one new "## Title" entry.
- replace: find the entry containing old_text (substring), swap it for content.
- remove: delete the entry containing old_text (substring).
- batch: apply operations[] atomically — validated against the FINAL budget only, all-or-nothing. **Preferred whenever you make more than one change**: free space (remove/replace) AND add in ONE call instead of multiple round-trips.

## Budget behavior
If a write would exceed the budget, you get the full current entries back with instructions to consolidate (merge/shorten/remove) and retry — in THIS turn, ideally as a single batch. A success response is terminal: do not repeat the write.`,
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'replace', 'remove', 'batch'],
          description: 'The memory operation to perform.',
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
      const store = getBoundedMemory();
      const action = params.action as string;

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
        success: result.success,
        ...(result.success ? { usage: result.usage } : { terminal: result.terminal ?? false }),
      });
      return renderResult(result);
    },
};
