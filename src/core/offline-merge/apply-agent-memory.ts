/**
 * A task's MEMORY.md write a host saved while this Mac was away (offline-host-core.ts
 * opAgentMemoryWrite): the journal v2 kind `agent-memory` (`{ taskId, mode, content, baseHash? }`),
 * which a host writes only for a Mac whose drains name it (apply-v2.ts APPLIED_V2_KINDS); an older
 * Mac's drain never asks for it, so the record waits on the host. The record's op id is the one the
 * Mac's own route gives the same call (offline-host-core.ts memoryWriteOpId), so the drain's ledger
 * check (offline-handover.ts) and the route's (web/middleware/op-id.ts) see one write either way.
 *
 *   append    the entry added to the file as it stands now, dated by the write's time: what the
 *             task's own session (or anyone) wrote meanwhile is kept, before it
 *   replace   only over the very text it was made on (`baseHash`, sha256 of it); any other text,
 *             or none named, keeps the Mac's file and logs the replaced version whole (a conflict,
 *             never the last writer winning)
 *
 * Checked as the online route checks it (web/routes/agent-memory-v1.ts): a complete task's file is
 * not written and a result past the limit is not written at all; both are refusals the batch logs.
 * The writer is recorded as online: the task's own session writes unstamped, another task's session
 * as that task, a person's device as the user. One row write under the lock, with the record's op
 * key, so a redrain after a crash writes nothing twice.
 */

import crypto from 'node:crypto';
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import type { V2Context, V2Record } from './apply-v2.js';
import { entryBase, exactTask, opKeyOf, withOp } from './apply-fields.js';
import { RefusedWrite } from './patch-check.js';

export function agentMemoryHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function writerStamp(record: V2Record, taskId: string): Promise<import('../sessions/agent-memory.js').AgentMemoryWriterStamp | null> {
  const { agentMemoryWriterName } = await import('../sessions/agent-memory.js');
  const actor = record.actor;
  if (actor?.kind === 'device') return { by: 'human' };
  if (actor?.kind === 'session') {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const rec = await getSessionByClaudeId(actor.sid).catch(() => null);
    const writerId = rec?.taskId || rec?.legacyTaskId || '';
    if (writerId === taskId) return null;
    const writer = writerId ? await exactTask(writerId) : null;
    if (writer) return { by: `task:${writer.id}`, by_name: agentMemoryWriterName(writer) };
  }
  return { by: 'agent', by_name: agentMemoryWriterName(undefined) };
}

export async function applyAgentMemoryWrite(ctx: V2Context, record: V2Record, taskId: string): Promise<void> {
  const m = record as { mode?: unknown; content?: unknown; baseHash?: unknown };
  const mode = m?.mode === 'replace' ? 'replace' as const : m?.mode === 'append' ? 'append' as const : null;
  if (!mode || typeof m?.content !== 'string' || !m.content.trim()) throw new RefusedWrite('a MEMORY.md write without its entry');
  if (!taskId) throw new RefusedWrite('a MEMORY.md write names no task');
  const content = m.content;
  const baseHash = typeof m.baseHash === 'string' ? m.baseHash : undefined;
  const opKey = opKeyOf(ctx, record);
  const pre = await exactTask(taskId);
  if (!pre) {
    ctx.conflicts.addDurable([{ ...entryBase(record), kind: 'task-deleted', taskId, field: 'agent_memory', replica: content, replicaAt: ctx.at }]);
    ctx.result.skipped++;
    return;
  }
  if (opKey && pre.applied_ops?.includes(opKey)) { ctx.result.skipped++; return; }
  const stamp = await writerStamp(record, taskId);
  const { AgentMemoryTooLongError, agentMemoryWriterAfter, nextAgentMemory } = await import('../sessions/agent-memory.js');
  const at = new Date(ctx.at).toISOString();
  const st: { outcome: 'applied' | 'skipped' | 'complete' | 'conflict' | 'too-long'; mac?: string; chars?: number } = { outcome: 'skipped' };
  const tm = await import('../task-manager.js');
  await tm.updateTaskRaw(taskId, (cur: Readonly<Task>) => {
    if (opKey && cur.applied_ops?.includes(opKey)) { st.outcome = 'skipped'; return null; }
    if (cur.phase === 'COMPLETE') { st.outcome = 'complete'; return null; }
    const current = cur.agent_memory?.text ?? '';
    if (mode === 'replace' && (!baseHash || agentMemoryHash(current) !== baseHash)) { st.outcome = 'conflict'; st.mac = current; return null; }
    let text: string;
    try {
      text = nextAgentMemory(current, content, mode, at);
    } catch (err) {
      if (err instanceof AgentMemoryTooLongError) { st.outcome = 'too-long'; st.chars = err.chars; return null; }
      throw err;
    }
    st.outcome = 'applied';
    return {
      agent_memory: { text, at, ...agentMemoryWriterAfter(cur.agent_memory, mode, stamp, at) },
      ...(opKey ? { applied_ops: withOp(cur, opKey) } : {}),
    } as Partial<Task>;
  }, { emitEvent: true, source: 'agent-memory' });
  if (st.outcome === 'complete') throw new RefusedWrite(`"${pre.title}" is complete: its MEMORY.md is kept as it was.`);
  if (st.outcome === 'too-long') throw new RefusedWrite(`This MEMORY.md would be ${st.chars} characters, over its limit: nothing of this write was applied.`);
  if (st.outcome === 'conflict') {
    ctx.conflicts.addDurable([{
      ...entryBase(record), kind: 'task-field', taskId, field: 'agent_memory', base: baseHash ?? 'unknown', mac: st.mac, replica: content,
      kept: 'mac', why: 'both-changed', replicaAt: ctx.at,
      reason: 'MEMORY.md was replaced away from this Mac over a version it no longer holds; the Mac\'s file is kept, the replacement is in the full entry',
    }]);
    ctx.result.skipped++;
    log.session.info('offline handover: a MEMORY.md replace made while away kept the Mac\'s file', { host: ctx.hostKey, taskId, seq: record.seq, opId: record.opId });
    return;
  }
  if (st.outcome === 'applied') {
    ctx.result.replayed++;
    log.session.info('offline handover: a MEMORY.md write made while away is here', { host: ctx.hostKey, taskId, mode, seq: record.seq, opId: record.opId, writer: stamp?.by ?? 'own' });
  } else {
    ctx.result.skipped++;
  }
}
