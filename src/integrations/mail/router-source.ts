import { createHash } from 'node:crypto';
import { registerRouterSource, RouterSourceError, type RouterNoiseOutcome } from '../../core/router/source-registry.js';
import type { RouterItem } from '../../core/router/types.js';
import type { MailStore, MessageRow } from './store.js';
import { MailBodySnapshotError, type MailBodyStore } from './bodies.js';

export function mailDeliveryVersion(sentAt: number, receivedAt?: number | null, bodyRef?: string | null, rfcMessageId = '', metadata?: unknown): string {
  return createHash('sha256').update(JSON.stringify([sentAt, receivedAt ?? null, rfcMessageId, bodyRef ?? null, metadata ?? null])).digest('hex');
}

const CACHE_PAYLOAD_FIELDS = new Set(['bodyBytesHint', 'bodyFormat', 'bodyTruncated', 'listUnsubscribe', 'bulkHeaders']);

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, one]) => [key, stableJson(one)]));
  }
  return value;
}

function deliveryJson(raw: string | null, payload = false): unknown {
  if (raw === null) return null;
  try {
    let value: unknown = JSON.parse(raw);
    if (payload && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      value = Object.fromEntries(Object.entries(value).filter(([key]) => !CACHE_PAYLOAD_FIELDS.has(key)));
    }
    return ['json', stableJson(value)];
  } catch { return ['invalid-json', raw]; }
}

export function mailRowDeliveryVersion(row: MessageRow): string {
  // A stored body's preview is derived cache text; without a body, it is the only content snapshot.
  return mailDeliveryVersion(row.sent_at, row.received_at, row.body_ref, row.rfc_message_id,
    [row.from_addr, row.subject, row.body_ref ? null : row.snippet, row.thread_id,
      deliveryJson(row.attachments_json), deliveryJson(row.payload, true)]);
}

export function mailRouterKey(account: string, message: string, rfcMessageId = '', version?: string): string {
  const parts: Array<string> = ['mail', account, rfcMessageId ? 'rfc' : 'cache', rfcMessageId || message];
  if (version !== undefined) parts.push(version);
  return JSON.stringify(parts);
}

function itemOf(row: MessageRow): RouterItem {
  const version = mailRowDeliveryVersion(row);
  return {
    source: { kind: 'mail', account: row.account_id, message: row.message_id, version },
    // The ledger's identity is the exact cached message: a sender chooses the RFC id, so another
    // message reusing it is never the same delivery. Copies still share the RFC scope key.
    key: mailRouterKey(row.account_id, row.message_id, '', version),
    scopeKey: mailRouterKey(row.account_id, row.message_id, row.rfc_message_id),
    ...(row.thread_id ? { threadKey: row.thread_id } : {}),
    sender: row.from_addr, subject: row.subject, preview: row.snippet,
  };
}

/** Where a moved message is read from first: the inbox, a folder, the archive, then the rest. */
const ROLE_ORDER = ['inbox', 'other', 'archive'];
const roleRank = (role: string | undefined) => {
  const at = ROLE_ORDER.indexOf(role ?? 'other');
  return at < 0 ? ROLE_ORDER.length : at;
};

/**
 * The current cached copy of the message a scope key names (mailRouterKey without a version), null
 * when the cache holds no copy of it, undefined when that cannot be told (a mail with no RFC id moved
 * under another id, or its scope changed): the caller keeps the item as it is.
 */
export async function relocateMailItem(store: Pick<MailStore, 'getMessage' | 'messagesByRfcId' | 'listMailboxes'>, scopeKey: string): Promise<RouterItem | null | undefined> {
  let parts: unknown;
  try { parts = JSON.parse(scopeKey); } catch { return undefined; }
  if (!Array.isArray(parts) || parts.length !== 4 || parts[0] !== 'mail' || typeof parts[1] !== 'string' || typeof parts[3] !== 'string') return undefined;
  const [, account, by, id] = parts as [string, string, string, string];
  if (by === 'cache') {
    const row = await store.getMessage(account, id);
    const item = row ? itemOf(row) : undefined;
    return item?.scopeKey === scopeKey ? item : undefined;
  }
  if (by !== 'rfc' || !id) return undefined;
  const rows = await store.messagesByRfcId(account, id);
  if (rows.length === 0) return null;
  const roles = new Map((await store.listMailboxes(account)).map((box) => [box.mailbox_id, box.role ?? undefined]));
  const best = [...rows].sort((a, b) => roleRank(roles.get(a.mailbox_id)) - roleRank(roles.get(b.mailbox_id)))[0]!;
  const item = itemOf(best);
  return item.scopeKey === scopeKey ? item : undefined;
}

/** `noise`: what the router's noise decision does to an email (router-noise.ts); without it, nothing. */
export function registerMailRouterSource(store: MailStore, bodies: MailBodyStore,
  opts: { noise?: (source: RouterItem['source']) => Promise<RouterNoiseOutcome> } = {}): () => void {
  const rowFor = async (source: RouterItem['source']) => {
    const row = await store.getMessage(source.account, source.message);
    if (!row) throw new RouterSourceError('source_missing', 'The exact email is not in the mail cache.');
    if (source.version !== undefined && source.version !== mailRowDeliveryVersion(row)) {
      throw new RouterSourceError('source_changed', 'A later delivery replaced this email. Confirm the current delivery before reading or routing it.');
    }
    return row;
  };
  return registerRouterSource('mail', {
    async resolve(source) { return itemOf(await rowFor(source)); },
    async read(source) {
      if (source.version === undefined) throw new RouterSourceError('source_changed', 'Reading an email needs its confirmed delivery version.');
      const row = await rowFor(source);
      const body = row.body_ref ? await bodies.read(row.body_ref, { accountId: row.account_id, messageId: row.message_id }).catch((error: unknown) => {
        if (error instanceof MailBodySnapshotError) throw new RouterSourceError('source_changed', 'The confirmed email body is no longer complete in the cache.');
        throw error;
      }) : null;
      const current = await rowFor(source);
      if (current.body_ref !== row.body_ref) throw new RouterSourceError('source_changed', 'The cached email body changed while it was being read.');
      let attachments: Array<{ filename?: string; mimeType?: string; bytes?: number }> = [];
      try {
        const raw: unknown = JSON.parse(row.attachments_json || '[]');
        if (Array.isArray(raw)) attachments = raw.filter((one) => one && typeof one === 'object').map((one: Record<string, unknown>) => ({
          ...(typeof one.filename === 'string' ? { filename: one.filename } : {}),
          ...(typeof one.mimeType === 'string' ? { mimeType: one.mimeType } : {}),
          ...(typeof one.bytes === 'number' ? { bytes: one.bytes } : {}),
        }));
      } catch { /* A damaged metadata cache does not fetch from the provider. */ }
      return { item: itemOf(row), body, bodyAvailable: !!body && (body.text !== undefined || body.html !== undefined), attachments, attachmentsAvailable: false as const };
    },
    async currentSources(sources) {
      const byAccount = new Map<string, Set<string>>();
      for (const one of sources) {
        if (one.kind === 'mail' && one.version !== undefined) byAccount.set(one.account, (byAccount.get(one.account) ?? new Set<string>()).add(one.message));
      }
      // One cache query per account for the whole batch: a wake checks up to 200 items each pass.
      const versions = new Map<string, string>();
      for (const [account, messages] of byAccount) {
        for (const row of await store.messagesByIds(account, [...messages])) {
          versions.set(JSON.stringify([account, row.message_id]), mailRowDeliveryVersion(row));
        }
      }
      return sources.filter((one) => one.kind === 'mail' && one.version !== undefined
        && versions.get(JSON.stringify([one.account, one.message])) === one.version);
    },
    relocate: (_source, scopeKey) => relocateMailItem(store, scopeKey),
    ...(opts.noise ? { noise: opts.noise } : {}),
  });
}
