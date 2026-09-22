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
 *     without bound. Reading an entry re-stamps it, so the cap is "unused for 30 days" — and a latch,
 *     which is stamped once and can never be re-stamped, lives as long as its conversation instead
 *     (see pruneAskObjectStore).
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

/**
 * What a latch belongs to — the same pair the conversation key is built from.
 *
 * The agent is part of a latch's identity for exactly the reason it is part of the conversation key:
 * the same object asked under two agents is two chats. Without it, asking about a mail under Walnut
 * took both latches, and the same mail under Mentor opened a NEW conversation whose first message
 * carried no quote and whose canned question was never sent — the drawer opened on an empty composer.
 *
 * An object and an agent are both plain strings, so they travel as a named pair rather than as two
 * positional arguments: swapping them would key every latch in the app wrongly and silently.
 */
export interface AskObjectLatchScope {
  agentId: string;
  /** The object, or `<objectKey>#<presetLatchName(preset)>` for a per-question latch. */
  key: string;
}

/**
 * Keys written before the agent joined this identity (`…-once:<name>:<objectKey>`) no longer match, and
 * that is the deliberate choice over migrating them: nothing in such a key records WHICH agent took it,
 * so a migration would have to guess, and guessing wrong suppresses a send that then cannot be
 * recovered from the UI — the empty-composer bug above. The prune below sweeps them (their scope cannot
 * name a live conversation), and the one-time cost is bounded and visible: the next ask about one of
 * those objects quotes it a second time, and a canned question the user clicks is asked again.
 */
function latchKey(name: AskObjectLatch, scope: AskObjectLatchScope): string {
  return `${FLAG_PREFIX}${name}:${scope.agentId}:${scope.key}`;
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
  scope: AskObjectLatchScope,
  storage: AskObjectStorage | undefined = browserStorage(),
): boolean {
  return Boolean(readStamped(storage, latchKey(name, scope)));
}

/** Take the latch. `true` the first time for this object, `false` after — including after a remount. */
export function claimAskObjectLatch(
  name: AskObjectLatch,
  scope: AskObjectLatchScope,
  opts: { storage?: AskObjectStorage; now?: () => number } = {},
): boolean {
  const storage = opts.storage ?? browserStorage();
  if (askObjectLatchTaken(name, scope, storage)) return false;
  writeStamped(storage, latchKey(name, scope), { at: (opts.now ?? Date.now)() });
  return true;
}

/**
 * Give a latch back, for something that turned out not to have happened.
 *
 * A latch is claimed when a message is handed to the transport, which is the earliest moment that
 * stops a double send — but not proof of delivery. When the send is afterwards known to have gone
 * nowhere (an offline socket, a 500), the claim has to be undone, because the latch lives on disk: a
 * question whose latch was burnt without being asked could never be asked again, in any window, ever.
 */
export function releaseAskObjectLatch(
  name: AskObjectLatch,
  scope: AskObjectLatchScope,
  storage: AskObjectStorage | undefined = browserStorage(),
): void {
  try { storage?.removeItem(latchKey(name, scope)); } catch { /* see writeStamped */ }
}

/**
 * The context block rides the FIRST message sent about an object and nothing after it: the model has
 * read the quote by then, and repeating it every turn would spend the window on the same mail. The
 * latch is in storage rather than in a module Set (which is what the Slack copy has) so closing and
 * reopening the drawer does not quote the object a second time.
 */
export function prefixContextOnce(
  scope: AskObjectLatchScope,
  contextBlock: string,
  input: string,
  opts: { storage?: AskObjectStorage; now?: () => number } = {},
): string {
  if (!contextBlock) return input;
  return claimAskObjectLatch('context', scope, opts) ? `${contextBlock}${input}` : input;
}

/**
 * Did an auto-sent question actually go out?
 *
 * `useChat().sendMessage` returns `void` and swallows the RPC's own promise: a 500 or an offline socket
 * raises a notification inside the hook and reports nothing to the caller, so no caller can await a
 * send. (Fixing THAT is a change to the hook's signature, not to this file.) The strongest contract a
 * view can honour without it is "claimed when dispatched, given back when the turn ends with nothing to
 * show for it", and this is the verdict half of it:
 *   . the conversation gained an assistant turn         → SENT, the server answered, so it landed;
 *   . the turn started and then stopped with no answer   → FAILED, which is the 500 / offline path;
 *   . anything before that                               → PENDING, ask again on the next change.
 *
 * Refusing to conclude before the turn has been seen to START is what keeps the verdict off the render
 * in which the send was dispatched — the hook's `isStreaming` has not landed yet in that one, and
 * reading it there would call every send a failure.
 *
 * Two deliberate asymmetries. A view unmounted mid-turn (the drawer closed) never concludes, so the
 * latch stays claimed: the question was asked, and re-asking it is worse than needing to type it again.
 * A turn that really did run but produced no assistant message at all reads as FAILED, which costs one
 * re-ask of a question the model answered with silence — the cheaper mistake of the two.
 */
export interface AutoSendWatch {
  /** Assistant turns present when the send was dispatched. */
  repliesAtDispatch: number;
  /** The turn has been seen to start: the hook is streaming, or the message is sitting in its queue. */
  started: boolean;
}

export interface AutoSendProbe {
  /** Assistant turns in the conversation now. */
  replies: number;
  streaming: boolean;
  queued: number;
}

export type AutoSendVerdict = 'pending' | 'sent' | 'failed';

export function autoSendOutcome(
  watch: AutoSendWatch,
  probe: AutoSendProbe,
): { watch: AutoSendWatch; verdict: AutoSendVerdict } {
  const started = watch.started || probe.streaming || probe.queued > 0;
  const next: AutoSendWatch = watch.started === started ? watch : { ...watch, started };
  if (probe.replies > watch.repliesAtDispatch) return { watch: next, verdict: 'sent' };
  if (started && !probe.streaming && probe.queued === 0) return { watch: next, verdict: 'failed' };
  return { watch: next, verdict: 'pending' };
}

/**
 * Is this latch's conversation among the ones that survived the prune?
 *
 * A latch key is `<FLAG_PREFIX><name>:<agentId>:<key>`, so dropping the `<name>:` head leaves exactly
 * the scope a conversation key carries. The full scope is tried first and the `#<presetLatchName>` tail
 * only as a fallback, so an object key that itself contains a `#` cannot be mis-cut into some other
 * object's live scope.
 */
function latchIsAnchored(key: string, liveScopes: Set<string>): boolean {
  const rest = key.slice(FLAG_PREFIX.length);
  const head = rest.indexOf(':');
  if (head < 0) return false;
  const scope = rest.slice(head + 1);
  if (liveScopes.has(scope)) return true;
  const hash = scope.lastIndexOf('#');
  return hash > 0 && liveScopes.has(scope.slice(0, hash));
}

/**
 * Drop what this store no longer needs. Called once on module load, and exported so a test can drive it.
 *
 * TWO rules, because the two kinds of key age differently and treating them alike was a bug:
 *
 *   . a CONVERSATION id is re-stamped every time it is read, so "30 days" honestly means 30 days
 *     UNUSED;
 *   . a LATCH is stamped once, when it is claimed, and can never be re-stamped — reading one has to
 *     stay a pure read, because the drawer reads it inside a state initializer and StrictMode runs
 *     those twice, so a read that wrote would consume a preset without ever sending it. Ageing a latch
 *     on its own timestamp therefore expires latches that are still in use: an object asked about for
 *     more than a month lost both of its latches on day 31, and the next open quoted the whole object
 *     into the existing chat again AND re-sent a canned question that had already been answered. So a
 *     latch lives exactly as long as the conversation it belongs to, which the agent id in its key is
 *     what makes findable. Still bounded: conversations do expire, and no latch can outlive one.
 *
 * An entry with no readable timestamp is dropped too: this module is the only writer, so anything else
 * in its namespace is either a leftover from a shape we no longer write or hand-edited, and keeping it
 * would defeat the cap.
 */
export function pruneAskObjectStore(storage: EnumerableStorage, now: number = Date.now()): number {
  const mine: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && key.startsWith(PRUNE_SCOPE)) mine.push(key);
  }

  // Pass 1: the conversation ids, on the unused-for-30-days rule. What survives leaves its scope
  // (`<agentId>:<objectKey>`) behind, which is what pass 2 anchors the latches to.
  const liveScopes = new Set<string>();
  const doomed: string[] = [];
  for (const key of mine) {
    if (key.startsWith(FLAG_PREFIX)) continue;
    if (!key.startsWith(STORE_PREFIX)) { doomed.push(key); continue; } // in the namespace, not a shape we write
    const at = readStamped(storage, key)?.at;
    if (typeof at !== 'number' || !Number.isFinite(at) || now - at > PRUNE_AFTER_MS) doomed.push(key);
    else liveScopes.add(key.slice(STORE_PREFIX.length));
  }

  // Pass 2: the latches, on "is the chat you belong to still remembered".
  for (const key of mine) {
    if (!key.startsWith(FLAG_PREFIX)) continue;
    if (!readStamped(storage, key) || !latchIsAnchored(key, liveScopes)) doomed.push(key);
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
