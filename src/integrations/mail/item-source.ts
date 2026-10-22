import { registerInboxMailSource } from '../../core/human-inbox/item-source-registry.js';
import type { MailStore } from './store.js';
import { messageTaskKey } from './message-tasks.js';
import type { InboxMailSource } from '../../core/human-inbox/types.js';

/** Cache-only metadata. No local-only mail_read self-call on behalf of a remote client. */
export function registerMailItemSource(store: MailStore): () => void {
  return registerInboxMailSource({ resolve: async (source: InboxMailSource) => {
    const account = await store.getAccount(source.account);
    const row = await store.getMessage(source.account, source.message);
    if (!account || !row) throw new Error('Email unavailable: the exact source is not in the mail cache');
    const key = messageTaskKey(row.account_id, row.rfc_message_id, row.message_id);
    let flags: unknown;
    try { flags = JSON.parse(row.flags_json ?? 'null'); } catch { flags = undefined; }
    return { key, source,
      ...(Array.isArray(flags) && row.updated_at > 0 ? { readObservation: {
        read: flags.includes('\\Seen'), observedAt: new Date(row.updated_at).toISOString(),
      } } : {}),
      adapter: {
        legacyTaskId: async (canonical: string) => (await store.tasks.getMessageTask(canonical))?.task_id,
        writeLegacy: async (canonical: string, taskId: string) => {
          const winner = await store.tasks.claimMessageTask({ key: canonical, accountId: source.account, messageId: source.message, taskId, now: Date.now() });
          if (winner !== taskId) throw new Error('The saved email task records disagree');
        },
      },
    };
  } });
}
