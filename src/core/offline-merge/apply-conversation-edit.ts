/**
 * The journal v2 kind `conversation-edit` on the Mac (docs/plan/walnut-companion-unified-replica.md,
 * stage 4d): a chat made, renamed, pinned or deleted on the cloud companion
 * (core/companion-conversations.ts), applied with the Mac's own conversation calls.
 *
 *   op       the Mac's chat now                          result                          letter
 *   create   not listed                                  listed under the box's id       no
 *            listed (the chat relay made it, a redrain)  nothing                         no
 *   delete   listed                                      deleted (a delete wins)         no
 *            the main chat                               kept (it is never deleted)      refused
 *            gone                                        nothing                         no
 *   rename   gone (a delete wins)                        nothing                         no
 *            the title the box showed, or an automatic   the box's title                 no
 *            renamed by a person since                   the newer rename                yes
 *   pin      gone                                        nothing                         no
 *            anything else                               the box's pin                   no
 *
 * A pin carries the value the box showed, so the Mac changing it since means both sides
 * set the same value: never a conflict. Every step is idempotent (the value already there
 * is a no-op), so a crash between an apply and its ledger row is harmless; the ledger keeps
 * the op id. A refusal throws RefusedWrite (the batch letters it); anything else is retried.
 */

import { log } from '../../logging/index.js';
import { RefusedWrite } from './patch-check.js';
import { entryBase } from './apply-fields.js';
import type { ConflictEntry } from './conflict-log.js';
import type { V2Context, V2Record } from './apply-v2.js';

const AGENT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONV_RE = /^conv-[A-Za-z0-9-]{1,64}$/;
const OPS = new Set(['create', 'rename', 'pin', 'delete']);

/** The chat a letter names: its title in quotes, or "a chat". */
export function chatLabel(title: unknown): string {
  return typeof title === 'string' && title.trim() ? `the chat "${title.trim()}"` : 'a chat';
}

async function announce(name: 'created' | 'updated' | 'deleted', data: Record<string, unknown>): Promise<void> {
  // The console's 'web-ui' subscriber carries it to the open windows, as an online change.
  const { bus, EventNames } = await import('../event-bus.js');
  const event = name === 'created' ? EventNames.CONVERSATION_CREATED : name === 'deleted' ? EventNames.CONVERSATION_DELETED : EventNames.CONVERSATION_UPDATED;
  bus.emit(event, data, ['web-ui'], { source: 'offline-handover' });
}

export async function applyConversationEdit(ctx: V2Context, record: V2Record): Promise<void> {
  const { agentId, conversationId, op } = record as { agentId?: unknown; conversationId?: unknown; op?: unknown };
  if (typeof agentId !== 'string' || !AGENT_RE.test(agentId) || typeof conversationId !== 'string' || !CONV_RE.test(conversationId)) {
    throw new RefusedWrite('a chat change from the cloud companion names no chat');
  }
  if (typeof op !== 'string' || !OPS.has(op)) throw new RefusedWrite(`a chat change from the cloud companion of an unknown kind (${String(op)})`);
  const conv = await import('../conversations.js');
  const row = (await conv.listConversations(agentId)).find((c) => c.id === conversationId);
  const done = (applied: boolean, what: string) => {
    if (applied) ctx.result.replayed++; else ctx.result.skipped++;
    log.agent.info(`offline handover: chat ${what}`, { host: ctx.hostKey, seq: record.seq, opId: record.opId, agentId, conversationId, op });
  };

  if (op === 'create') {
    if (row) return done(false, 'made on the companion was already here');
    const title = typeof record.title === 'string' ? record.title : '';
    const meta = await conv.adoptConversationRow(agentId, conversationId, { title, createdAt: new Date(ctx.at).toISOString() });
    if (meta) await announce('created', { agentId, conversation: meta });
    return done(!!meta, meta ? 'made on the companion is here' : 'made on the companion was already here');
  }
  // A chat the Mac no longer has: a delete wins, and a delete of nothing is nothing.
  if (!row) return done(false, 'change skipped, the chat is gone');

  if (op === 'delete') {
    if (row.isMain) throw new RefusedWrite(`${chatLabel(row.title)} is the main chat on your Mac, which is never deleted, so it was kept`);
    await conv.deleteConversation(agentId, conversationId);
    await announce('deleted', { agentId, conversationId, activeConversationId: await conv.getActiveConversationId(agentId) });
    return done(true, 'deleted on the companion is deleted here');
  }

  if (op === 'pin') {
    if (typeof record.pinned !== 'boolean') throw new RefusedWrite('a chat pin from the cloud companion without its value');
    if (!!row.pinned === record.pinned) return done(false, 'pin already here');
    const conversation = await conv.setPinned(agentId, conversationId, record.pinned);
    await announce('updated', { agentId, conversation });
    return done(true, 'pin from the companion is here');
  }

  // rename
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  if (!title) throw new RefusedWrite('a chat rename from the cloud companion without a title');
  if (row.title === title) return done(false, 'rename already here');
  const base = (record.base as { title?: unknown } | undefined)?.title;
  // A person renamed it on the Mac since the box saw it: the newer rename wins, lettered.
  const macAt = typeof base === 'string' && row.title === base ? 0 : Date.parse(row.titleSetAt ?? '') || 0;
  if (macAt > 0) {
    const kept = macAt > ctx.at ? 'mac' : 'replica';
    const entry: ConflictEntry = {
      ...entryBase(record), kind: 'conversation', field: 'title', kept,
      ...(typeof base === 'string' ? { base } : {}), mac: row.title, replica: title, macAt, replicaAt: ctx.at,
      reason: 'both sides renamed this chat',
    };
    // On disk before the rename: a crash in between letters again, never loses a name.
    ctx.conflicts.addDurable([entry]);
    if (kept === 'mac') return done(false, 'rename from the companion lost to a newer one here');
  }
  const conversation = await conv.renameConversation(agentId, conversationId, title, { at: new Date(ctx.at).toISOString() });
  await announce('updated', { agentId, conversation });
  return done(true, 'rename from the companion is here');
}
