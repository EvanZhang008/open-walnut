/**
 * The Walnut conversation behind an "ask about this object" drawer.
 *
 * One conversation per object (a mail row, a Slack message, whatever a surface can name), created
 * through the agent's own conversations route on first open and remembered in localStorage, so
 * reopening the same object lands in the same chat with its history. The agent's MAIN conversation is
 * never used: a question about one mail does not belong in the reader's main thread.
 *
 * Ported from the Slack plugin's `src/web/ask-conversation.ts` (a plugin cannot import core, so the
 * two files exist; they must behave identically). Three things this one adds, because core can:
 *   . the typed client (`@/api/conversations`) instead of a raw fetch;
 *   . forget-on-unknown — a remembered id the server no longer knows makes a NEW conversation
 *     instead of a chat that renders forever empty. A FAILED read is not an empty answer: when the
 *     list request itself refuses, the remembered id is kept and used, never discarded;
 *   . a 30-day prune on module load, so a year of asking about mail does not grow localStorage
 *     without bound. Reading an entry re-stamps it, so the cap is "unused for 30 days".
 */
import { createConversation, listConversations } from '@/api/conversations';

/** Conversation ids. The agent id is part of the key: the same object asked under two agents is two chats. */
const STORE_PREFIX = 'walnut:ask-object:';
/** Once-per-object latches (the context block, the preset). Same family, so one prune covers both. */
const FLAG_PREFIX = 'walnut:ask-object-once:';
/** Every key this module owns starts with this, which is what makes the prune safe. */
const PRUNE_SCOPE = 'walnut:ask-object';
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const TITLE_MAX = 60;

export type AskObjectStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
/** What the prune needs on top: it has to enumerate its own keys. */
export type EnumerableStorage = AskObjectStorage & Pick<Storage, 'length' | 'key'>;

export interface AskObjectConversationDeps {
  agentId: string;
  storage?: AskObjectStorage;
  /** The agent's existing conversation ids — how a deleted one is noticed. Injected in tests. */
  listIds?: (agentId: string) => Promise<string[]>;
  /** Make one and answer its id. Injected in tests. */
  create?: (agentId: string, title: string) => Promise<string>;
  now?: () => number;
}

function browserStorage(): AskObjectStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    // Private mode / disabled storage: the drawer still works, it just forgets.
    return undefined;
  }
}

function storeKey(agentId: string, key: string): string {
  return `${STORE_PREFIX}${agentId}:${key}`;
}

interface Stamped { id?: string; at?: number }

function readStamped(storage: AskObjectStorage | undefined, key: string): Stamped | undefined {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(key) ?? null;
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Stamped;
  } catch {
    // Not ours / hand-edited. Treated as absent rather than trusted.
  }
  return undefined;
}

function writeStamped(storage: AskObjectStorage | undefined, key: string, value: Stamped): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or private mode — losing the memory is better than losing the drawer.
  }
}

/**
 * `<prefix>: <subject>`, clipped to 60 chars — the same shape the Slack drawer titles with, so a
 * console listing ask conversations from two surfaces reads as one list. `prefix` already names the
 * surface and the author (`Mail: Bo Marina`).
 */
export function askObjectTitle(prefix: string, subject: string): string {
  const head = (prefix.replace(/\s+/g, ' ').trim() || 'Ask Walnut').slice(0, TITLE_MAX);
  const words = subject.replace(/\s+/g, ' ').trim();
  if (!words) return head;
  const room = TITLE_MAX - head.length - 2;
  if (room <= 8) return head;
  return `${head}: ${words.length > room ? `${words.slice(0, room - 1).trimEnd()}…` : words}`;
}

/**
 * One request in flight per key. The drawer's effect re-runs when a display name resolves a moment
 * after it opened; without this the second run raced the first, both made a conversation, and the one
 * that landed LAST owned localStorage while the chat on screen showed the other — so reopening the
 * object landed somewhere else (the bug documented in the Slack copy).
 */
const inFlight = new Map<string, Promise<string>>();

/** The conversation id for this object: the remembered one, else a new one (remembered). Throws when the server refuses. */
export function askObjectConversationFor(
  key: string,
  title: string,
  deps: AskObjectConversationDeps,
): Promise<string> {
  const flightKey = `${deps.agentId}\u0000${key}`;
  const pending = inFlight.get(flightKey);
  if (pending) return pending;
  const resolved = resolveConversation(key, title, deps).finally(() => { inFlight.delete(flightKey); });
  inFlight.set(flightKey, resolved);
  return resolved;
}

async function resolveConversation(
  key: string,
  title: string,
  deps: AskObjectConversationDeps,
): Promise<string> {
  const storage = deps.storage ?? browserStorage();
  const now = deps.now ?? Date.now;
  const full = storeKey(deps.agentId, key);
  const remembered = readStamped(storage, full)?.id ?? '';
  if (remembered) {
    if (await stillKnown(remembered, deps)) {
      writeStamped(storage, full, { id: remembered, at: now() });
      return remembered;
    }
    try { storage?.removeItem(full); } catch { /* see writeStamped */ }
  }
  const create = deps.create ?? defaultCreate;
  const id = await create(deps.agentId, title);
  if (!id) throw new Error('Walnut did not name the conversation it made.');
  writeStamped(storage, full, { id, at: now() });
  return id;
}

/**
 * Is the remembered conversation still there? A clear NO (the list answered and it is absent) means
 * forget it. A refusal is NOT a no — an unreachable server would otherwise mint a new conversation
 * per open and scatter the history, so a failed read keeps the id.
 */
async function stillKnown(id: string, deps: AskObjectConversationDeps): Promise<boolean> {
  const list = deps.listIds ?? defaultListIds;
  try {
    return (await list(deps.agentId)).includes(id);
  } catch {
    return true;
  }
}

async function defaultListIds(agentId: string): Promise<string[]> {
  const answer = await listConversations(agentId);
  return answer.conversations.map((c) => c.id);
}

async function defaultCreate(agentId: string, title: string): Promise<string> {
  const conversation = await createConversation(agentId, title);
  return conversation?.id ?? '';
}

/** Drop a remembered id (a conversation the user deleted), so the next open makes a new one. */
export function forgetAskObjectConversation(
  key: string,
  agentId: string,
  storage: AskObjectStorage | undefined = browserStorage(),
): void {
  try { storage?.removeItem(storeKey(agentId, key)); } catch { /* see writeStamped */ }
}

/** The once-per-object latches this module knows. */
export type AskObjectLatch = 'context' | 'preset';

function latchKey(name: AskObjectLatch, key: string): string {
  return `${FLAG_PREFIX}${name}:${key}`;
}

/**
 * The latch key for ONE preset on one object, rather than for the object.
 *
 * `preset` was latched per object, which is right for the context block (the model has read the quote
 * after the first turn) and wrong for a question: having asked Walnut to summarize a mail, clicking
 * "Finish unsubscribing" on the same mail later opened the drawer and sent nothing, because the
 * object's one preset latch was already taken. Each distinct question gets its own latch, so asking
 * twice for the SAME thing still sends once.
 *
 * Hashed rather than stored verbatim: a preset is a paragraph, and a storage key per object per
 * paragraph would put the prompts themselves in localStorage and blow past its per-origin budget on a
 * busy mailbox. The hash is a 32-bit FNV-1a — a collision means one preset silently counts as another
 * on the same object, which is the same outcome as today's behaviour and is why it is safe here.
 */
export function presetLatchName(preset: string): string {
  let hash = 0x811c9dc5;
  for (let at = 0; at < preset.length; at += 1) {
    hash ^= preset.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Has this latch already been taken for this object? A read, never a write — safe under StrictMode. */
export function askObjectLatchTaken(
  name: AskObjectLatch,
  key: string,
  storage: AskObjectStorage | undefined = browserStorage(),
): boolean {
  return Boolean(readStamped(storage, latchKey(name, key)));
}

/** Take the latch. `true` the first time for this object, `false` after — including after a remount. */
export function claimAskObjectLatch(
  name: AskObjectLatch,
  key: string,
  opts: { storage?: AskObjectStorage; now?: () => number } = {},
): boolean {
  const storage = opts.storage ?? browserStorage();
  if (askObjectLatchTaken(name, key, storage)) return false;
  writeStamped(storage, latchKey(name, key), { at: (opts.now ?? Date.now)() });
  return true;
}

/**
 * The context block rides the FIRST message sent about an object and nothing after it: the model has
 * read the quote by then, and repeating it every turn would spend the window on the same mail. The
 * latch is in storage rather than in a module Set (which is what the Slack copy has) so closing and
 * reopening the drawer does not quote the object a second time.
 */
export function prefixContextOnce(
  key: string,
  contextBlock: string,
  input: string,
  opts: { storage?: AskObjectStorage; now?: () => number } = {},
): string {
  if (!contextBlock) return input;
  return claimAskObjectLatch('context', key, opts) ? `${contextBlock}${input}` : input;
}

/**
 * Drop entries older than 30 days. Called once on module load, and exported so a test can drive it.
 * An entry with no readable timestamp is dropped too: this module is the only writer, so anything
 * else in its namespace is either a leftover from a shape we no longer write or hand-edited, and
 * keeping it would defeat the cap.
 */
export function pruneAskObjectStore(storage: EnumerableStorage, now: number = Date.now()): number {
  const doomed: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key || !key.startsWith(PRUNE_SCOPE)) continue;
    const at = readStamped(storage, key)?.at;
    if (typeof at !== 'number' || !Number.isFinite(at) || now - at > PRUNE_AFTER_MS) doomed.push(key);
  }
  for (const key of doomed) {
    try { storage.removeItem(key); } catch { /* see writeStamped */ }
  }
  return doomed.length;
}

try {
  if (typeof localStorage !== 'undefined') pruneAskObjectStore(localStorage);
} catch {
  // No DOM (unit tests) or storage disabled: nothing to prune.
}
