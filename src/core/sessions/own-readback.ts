/**
 * What Main or a VP keeps across conversations, read back at the start of every new conversation
 * and after every compaction: its own MEMORY.md, the index of its skills, and its recent work in
 * its Threads. 2026-11-08, the user, after the OpenMausBot report: "we can first learn to use the
 * memory and skill system from that for each VP". A bot there sees its memory, its skills' index
 * and one line per other recent conversation at the start of every session and again after a
 * compaction; a Walnut node saw its MEMORY.md only after a compaction, last in a hook text of
 * 9,500 characters, where the cut took it first, and nothing of it in a new conversation.
 *
 * Delivery: Claude Code's own SessionStart hook (src/providers/own-readback-hook.ts), sources
 * `startup` (a new conversation, never a resume of one) and `compact`, so no message carries it and
 * it costs nothing per turn. It is a hook of its own beside open_items, because the CLI's limit
 * (HOOK_CONTEXT_MAX) holds per hook: checked 2026-11-08 on CLI 2.1.312, two SessionStart hooks of
 * 8,500 characters each both reached the model whole.
 *
 * The spawn adds that hook only to a prompt carrying OWN_READBACK_MARK (the role line saying so),
 * and for such a session the compaction's open_items leaves MEMORY.md out, so the file comes once.
 * An older prompt a resume replays gets neither: it keeps reading MEMORY.md in open_items.
 */
import type { Task } from '../types.js';
import { screenDocumentForPrompt } from '../memory-safety.js';
import { agentMemoryAfterCompaction } from './agent-memory.js';
import { HOOK_CONTEXT_MAX } from './open-items.js';

import { OWN_READBACK_MARK, ownReadbackEnabled } from './own-readback-mark.js';

export { OWN_READBACK_MARK, ownReadbackEnabled };

export type OwnReadbackHook = 'startup' | 'compact';

/** This session was spawned with the own-readback hook: its compaction readback leaves MEMORY.md to it. */
export function ownReadbackHooked(record: { appliedAppendSystemPrompt?: string }, env: NodeJS.ProcessEnv = process.env): boolean {
  return ownReadbackEnabled(env) && (record.appliedAppendSystemPrompt ?? '').includes(OWN_READBACK_MARK);
}

const isNode = (task: Pick<Task, 'org_role'>): boolean => task.org_role === 'main' || task.org_role === 'lead';

/** The block for a task's session; '' when it keeps nothing yet (the hook then injects nothing). */
export async function ownReadbackText(task: Task, hook: OwnReadbackHook, now = Date.now()): Promise<string> {
  if (task.phase === 'COMPLETE' || !ownReadbackEnabled()) return '';
  const parts: string[] = [];
  const memory = agentMemoryAfterCompaction(task);
  if (memory) parts.push(screenDocumentForPrompt(memory, 'agent MEMORY.md'));
  const { listAgentSkills, agentSkillsIndex } = await import('./agent-skills.js');
  const [own, org] = await Promise.all([
    listAgentSkills('own', task.id).catch(() => []),
    isNode(task) ? listAgentSkills('org', task.id).catch(() => []) : Promise.resolve([]),
  ]);
  const skills = agentSkillsIndex(own, org);
  if (skills) parts.push(skills);
  if (isNode(task)) {
    const { readThreads } = await import('../org/threads-store.js');
    const { recentWorkLines, recentWorkText } = await import('../org/recent-work.js');
    const threads = await readThreads(task.id).catch(() => null);
    const recent = threads ? recentWorkText(recentWorkLines(threads.threads, now), now) : '';
    if (recent) parts.push(screenDocumentForPrompt(recent, 'recent work'));
  }
  if (!parts.length) return '';
  const head = hook === 'startup'
    ? 'Walnut reads back what you keep across conversations, at the start of this new one:'
    : 'Walnut reads back what you keep across conversations, after this compaction:';
  const text = [head, ...parts].join('\n\n');
  return fitOwn(text);
}

/** Within what a hook may add, cut at a line end, saying where the rest is. */
function fitOwn(text: string): string {
  if (text.length <= HOOK_CONTEXT_MAX) return text;
  const tail = '\n\n(Cut here: agent_memory_read, agent_skill_read and thread_list read the rest.)';
  const room = HOOK_CONTEXT_MAX - tail.length;
  const end = text.lastIndexOf('\n', room);
  return `${text.slice(0, end > room / 2 ? end : room).trimEnd()}${tail}`;
}
