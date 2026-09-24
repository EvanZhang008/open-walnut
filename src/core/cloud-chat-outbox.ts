/**
 * Cloud → primary outbox for chat turns the CLOUD COMPANION answered itself.
 *
 * ## Why this exists
 *
 * A phone chat turn sent to the companion is relayed to the primary, which owns
 * the conversation (routes/chat-turn-relay.ts). When the primary provably cannot
 * receive it, the companion now answers the turn on its own lane instead of
 * failing it (routes/cloud-chat-fallback.ts). That answer has to reach the
 * primary's history exactly once, and it must NOT get there by the companion
 * writing `conversations/<agent>/<conv>.json`: that file has one writer, the
 * primary, because git-sync merges it per file last-writer-wins and two boxes
 * appending inside one sync window drops one side's entries. (Commit 62e54ed4
 * removed exactly that: a degraded replica answer persisted into the synced file.)
 *
 * So the companion banks each turn HERE, in `cache/` (excluded from git-sync),
 * one file per turn, and hands it to the primary over the `server.chat.adopt`
 * control action once the bridge is back. The primary writes it idempotently by
 * turnId (chat-history.adoptCloudTurn); the companion deletes the file only after
 * the primary said adopted or already-present.
 *
 * ## Entry lifecycle
 *
 *   running  → written BEFORE the turn starts, so the user's words survive a crash
 *              and a GET /messages during the turn still shows them.
 *   answered → the answer landed (written before the terminal SSE frame, so the
 *              phone's refetch on `message-end` already sees it).
 *   failed   → the turn produced no answer; adopted as the user's message plus an
 *              error notification, the same shape a failed primary turn leaves.
 *
 * A `running` entry written by an EARLIER process of this server is a turn whose
 * runner died with the process; the flush adopts it as failed.
 *
 * ## Drain triggers
 *
 * The trio the sibling queues use (task-queue, control-queue, send-queue): the
 * primary's bridge (re)connect, a sweep after each finished fallback turn, and a
 * 60s floor. The sweep stops at the first transport failure (the rest would fail
 * identically) and keeps the entry on anything that is not a definite answer.
 *
 * Files: cache/cloud-chat-outbox/<turnId>.json (NON-git on both boxes).
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CLOUD_MODE, WALNUT_HOME } from '../constants.js';
import { writeJsonFile } from '../utils/fs.js';
import { log } from '../logging/index.js';

export const CLOUD_CHAT_OUTBOX_DIR = path.join(WALNUT_HOME, 'cache', 'cloud-chat-outbox');

/** Identity of THIS server process: a `running` entry from another one is dead. */
const BOOT_ID = crypto.randomUUID();

/** turnIds come from crypto.randomUUID on the POST route; anything else is refused
 *  before it can become a filename. */
const TURN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/;
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONVERSATION_ID_RE = /^conv-[A-Za-z0-9-]+$/;

/**
 * Bound on what one adoption RPC may carry. One oversized control frame closes
 * the shared bridge socket and kills every in-flight RPC with it (the 2026-08-09
 * 1009 incident), so the answer is clipped on the way out rather than refused on
 * the way in: a refusal would drop the turn forever.
 */
const MAX_TEXT_CHARS = 200_000;

const FLUSH_INTERVAL_MS = 60_000;
const ADOPT_RPC_TIMEOUT_MS = 30_000;
/**
 * A banked turn is conversation history the user already read, so it is kept far
 * longer than a banked send (24h there): an entry is only dropped when the
 * primary has been unreachable for a month.
 */
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;

export type CloudChatTurnState = 'running' | 'answered' | 'failed';

export interface CloudChatOutboxEntry {
  v: 1;
  turnId: string;
  agentId: string;
  conversationId: string;
  userText: string;
  userAt: string;
  state: CloudChatTurnState;
  answerText?: string;
  answeredAt?: string;
  error?: string;
  /** chat-history.cloudEngineLabel(<companion lane session>), once known. */
  engine?: string;
  /** Process that ran the turn (see BOOT_ID). */
  bootId: string;
  updatedAt: string;
}

function entryFile(turnId: string): string {
  return path.join(CLOUD_CHAT_OUTBOX_DIR, `${turnId}.json`);
}

function isEntry(value: unknown): value is CloudChatOutboxEntry {
  const e = value as Partial<CloudChatOutboxEntry> | null;
  return !!e
    && typeof e.turnId === 'string' && TURN_ID_RE.test(e.turnId)
    && typeof e.agentId === 'string' && AGENT_ID_RE.test(e.agentId)
    && typeof e.conversationId === 'string' && CONVERSATION_ID_RE.test(e.conversationId)
    && typeof e.userText === 'string'
    && typeof e.userAt === 'string'
    && (e.state === 'running' || e.state === 'answered' || e.state === 'failed');
}

/**
 * Bank the start of one fallback turn. Returns the entry, or null when the write
 * failed; the caller then must not answer the turn, because an answer that can
 * never reach the primary's history is one the user loses on the next reload.
 */
export async function bankCloudTurnStart(input: {
  turnId: string; agentId: string; conversationId: string; userText: string;
}): Promise<CloudChatOutboxEntry | null> {
  if (!CLOUD_MODE || !TURN_ID_RE.test(input.turnId)) return null;
  const now = new Date().toISOString();
  const entry: CloudChatOutboxEntry = {
    v: 1, ...input, userAt: now, state: 'running', bootId: BOOT_ID, updatedAt: now,
  };
  try {
    await writeJsonFile(entryFile(input.turnId), entry);
    log.web.info('cloud chat outbox: turn banked', {
      turnId: input.turnId, agentId: input.agentId, conversationId: input.conversationId,
    });
    return entry;
  } catch (err) {
    log.web.error('cloud chat outbox: FAILED to bank a turn', {
      turnId: input.turnId, conversationId: input.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Record how a banked turn ended. Never throws; returns whether it landed. */
export async function finishCloudTurn(
  entry: CloudChatOutboxEntry,
  outcome: { answerText: string; engine?: string } | { error: string; engine?: string },
): Promise<boolean> {
  const now = new Date().toISOString();
  const next: CloudChatOutboxEntry = 'answerText' in outcome
    ? { ...entry, state: 'answered', answerText: outcome.answerText, answeredAt: now, updatedAt: now }
    : { ...entry, state: 'failed', error: outcome.error, updatedAt: now };
  if (outcome.engine) next.engine = outcome.engine;
  try {
    await writeJsonFile(entryFile(entry.turnId), next);
    return true;
  } catch (err) {
    log.web.error('cloud chat outbox: FAILED to record a turn outcome', {
      turnId: entry.turnId, conversationId: entry.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Every banked turn, oldest first (optionally one conversation's). */
export async function listCloudTurns(filter?: {
  agentId?: string; conversationId?: string;
}): Promise<CloudChatOutboxEntry[]> {
  let names: string[];
  try {
    names = (await fsp.readdir(CLOUD_CHAT_OUTBOX_DIR)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: CloudChatOutboxEntry[] = [];
  for (const name of names) {
    try {
      const raw = JSON.parse(await fsp.readFile(path.join(CLOUD_CHAT_OUTBOX_DIR, name), 'utf-8'));
      if (!isEntry(raw)) continue;
      if (filter?.agentId && raw.agentId !== filter.agentId) continue;
      if (filter?.conversationId && raw.conversationId !== filter.conversationId) continue;
      out.push(raw);
    } catch { /* a half-written or foreign file: the flush reaps it */ }
  }
  return out.sort((a, b) => (a.userAt < b.userAt ? -1 : a.userAt > b.userAt ? 1 : 0));
}

/** True when a `running` entry's runner is gone (written by another process). */
function isOrphanedRun(entry: CloudChatOutboxEntry): boolean {
  return entry.state === 'running' && entry.bootId !== BOOT_ID;
}

function clip(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[clipped by Walnut]` : text;
}

/** The `server.chat.adopt` payload for one entry (null while it is still running). */
function adoptPayload(entry: CloudChatOutboxEntry): Record<string, unknown> | null {
  if (entry.state === 'running' && !isOrphanedRun(entry)) return null;
  const base = {
    v: 1,
    turnId: entry.turnId,
    agentId: entry.agentId,
    conversationId: entry.conversationId,
    userText: clip(entry.userText),
    userAt: entry.userAt,
    engine: entry.engine ?? 'cloud:unknown',
  };
  if (entry.state === 'answered' && entry.answerText) {
    return { ...base, answerText: clip(entry.answerText), answeredAt: entry.answeredAt ?? entry.updatedAt };
  }
  return {
    ...base,
    error: entry.state === 'running'
      ? 'The cloud companion restarted before it finished answering this turn.'
      : (entry.error ?? 'The cloud companion did not answer this turn.'),
  };
}

let flushing = false;
/** A sweep was asked for while one ran (e.g. a turn finished mid-sweep): run
 *  once more at the end instead of leaving that turn to the 60s floor. */
let flushAgain = false;

/**
 * Hand every finished banked turn to the primary, oldest first.
 *
 * Per entry: delete on `adopted`/`duplicate`, and on a definite domain refusal
 * (the primary ran the action and rejected the payload, which an identical retry
 * would repeat). Keep and STOP on anything transport-shaped: no bridge, an old
 * primary (needs_upgrade), a timeout, or a 5xx. A timeout is never a refusal
 * (the send-queue's 2026-08-21 loss was exactly that misreading).
 */
export async function flushCloudChatOutbox(): Promise<number> {
  if (!CLOUD_MODE) return 0;
  if (flushing) { flushAgain = true; return 0; }
  flushing = true;
  flushAgain = false;
  let adopted = 0;
  try {
    const entries = await listCloudTurns();
    if (entries.length === 0) return 0;
    const { bridgeForHost } = await import('../web/ws/bridge-registry.js');
    // Cheap precheck: with no bridge every attempt fails identically, and the
    // relay layer may spend a short grace window finding that out.
    if (!bridgeForHost('__local__').connected) return 0;
    const { callPrimaryControl } = await import('../web/routes/v1-control-relay.js');
    for (const entry of entries) {
      if (Date.now() - Date.parse(entry.userAt) > MAX_AGE_MS) {
        log.web.warn('cloud chat outbox: banked turn expired before the primary returned, dropping', {
          turnId: entry.turnId, conversationId: entry.conversationId, userAt: entry.userAt,
        });
        await fsp.rm(entryFile(entry.turnId), { force: true }).catch(() => {});
        continue;
      }
      const payload = adoptPayload(entry);
      if (!payload) continue; // still running in this process
      const outcome = await callPrimaryControl('server.chat.adopt', '__server__', payload, ADOPT_RPC_TIMEOUT_MS);
      if (outcome.ok) {
        const result = outcome.result;
        if (result.adopted === true || result.duplicate === true) {
          await fsp.rm(entryFile(entry.turnId), { force: true }).catch(() => {});
          adopted++;
          log.web.info('cloud chat outbox: the primary adopted a banked turn', {
            turnId: entry.turnId, conversationId: entry.conversationId, duplicate: result.duplicate === true,
          });
          continue;
        }
        log.web.warn('cloud chat outbox: unexpected adopt reply, keeping the turn', {
          turnId: entry.turnId, reply: JSON.stringify(result).slice(0, 200),
        });
        break;
      }
      const failure = outcome.failure;
      const message = failure.message ?? '';
      const transportShaped = failure.kind !== 'error'
        || failure.status >= 500
        || /timed out|timeout/i.test(message);
      if (transportShaped) {
        log.web.info('cloud chat outbox: the primary cannot adopt yet, retrying later', {
          turnId: entry.turnId, failureKind: failure.kind, reason: message,
        });
        break;
      }
      log.web.warn('cloud chat outbox: the primary refused a banked turn, dropping', {
        turnId: entry.turnId, conversationId: entry.conversationId, reason: message,
      });
      await fsp.rm(entryFile(entry.turnId), { force: true }).catch(() => {});
    }
    return adopted;
  } catch (err) {
    log.web.warn('cloud chat outbox: flush failed', { error: err instanceof Error ? err.message : String(err) });
    return adopted;
  } finally {
    flushing = false;
    if (flushAgain) {
      flushAgain = false;
      setImmediate(() => { void flushCloudChatOutbox(); });
    }
  }
}

/** CLOUD box: start the drain triggers (bridge reconnect + a 60s floor sweep). */
export function startCloudChatOutboxFlush(): { stop: () => void } {
  const timer = setInterval(() => { void flushCloudChatOutbox(); }, FLUSH_INTERVAL_MS);
  timer.unref?.();
  let unhook: (() => void) | null = null;
  void (async () => {
    try {
      const { addPrimaryBridgeConnectedHandler } = await import('../web/ws/bridge-registry.js');
      unhook = addPrimaryBridgeConnectedHandler(() => {
        void flushCloudChatOutbox();
      });
    } catch (err) {
      log.web.warn('cloud chat outbox: could not hook the bridge-connected trigger', { error: String(err) });
    }
  })();
  // Entries banked before a restart: drain soon after boot, not a minute later.
  const boot = setTimeout(() => { void flushCloudChatOutbox(); }, 5_000);
  boot.unref?.();
  return {
    stop: () => {
      clearInterval(timer);
      clearTimeout(boot);
      unhook?.();
    },
  };
}

// ─── Primary side: `server.chat.adopt` ──────────────────────────────────────

/** A precise refusal for the relay (thrown as SessionControlError by the caller).
 *  400 = this payload is wrong (the replica drops the entry); 503 = this box is
 *  not the one that adopts (the replica keeps it for the real primary). */
export class CloudTurnAdoptError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
    this.name = 'CloudTurnAdoptError';
  }
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/**
 * PRIMARY: write one turn the companion answered into this box's history.
 * Idempotent by turnId, so a retried adoption answers `duplicate: true`.
 *
 * Inputs are validated with the ROUTE's own shapes (the same rule every
 * `server.*` relay action follows): the payload arrives from another box.
 */
export async function handlePrimaryChatAdopt(p: Record<string, unknown>): Promise<Record<string, unknown>> {
  // The conversation file has ONE writer, the primary. A cloud-exec replica runs
  // its own loopback daemon, so a local client of that daemon can reach this
  // action here too; writing the file on this box would break that rule. 503,
  // never 400: a flush that somehow reached a replica must KEEP its entry.
  if (CLOUD_MODE) {
    throw new CloudTurnAdoptError(
      'server.chat.adopt runs only on the primary; this box is a cloud replica and never writes conversation files',
      503,
    );
  }
  const agentId = typeof p.agentId === 'string' && p.agentId ? p.agentId : 'general';
  const conversationId = typeof p.conversationId === 'string' ? p.conversationId : '';
  const turnId = typeof p.turnId === 'string' ? p.turnId : '';
  const userText = typeof p.userText === 'string' ? p.userText : '';
  const userAt = isoOrNull(p.userAt);
  if (!AGENT_ID_RE.test(agentId)) throw new CloudTurnAdoptError('invalid agentId');
  if (!CONVERSATION_ID_RE.test(conversationId)) throw new CloudTurnAdoptError('invalid conversationId');
  if (!TURN_ID_RE.test(turnId)) throw new CloudTurnAdoptError('invalid turnId');
  if (!userText.trim() || userText.length > MAX_TEXT_CHARS + 64) throw new CloudTurnAdoptError('invalid userText');
  if (!userAt) throw new CloudTurnAdoptError('invalid userAt');
  const answerText = typeof p.answerText === 'string' && p.answerText.trim() ? p.answerText : undefined;
  if (answerText && answerText.length > MAX_TEXT_CHARS + 64) throw new CloudTurnAdoptError('answerText too large');
  const rawEngine = typeof p.engine === 'string' ? p.engine : '';
  const { adoptCloudTurn, CLOUD_ENGINE_PREFIX } = await import('./chat-history.js');
  const engine = rawEngine.startsWith(CLOUD_ENGINE_PREFIX) && rawEngine.length <= 120
    ? rawEngine
    : `${CLOUD_ENGINE_PREFIX}unknown`;

  // A conversation the phone created on the companion may not be in this box's
  // index yet; write the row here so both sides of any index merge carry it
  // (same reason the turn relay does it, routes/chat-turn-relay.ts).
  const { ensureConversationRow } = await import('./conversations.js');
  await ensureConversationRow(agentId, conversationId, userText);

  const outcome = await adoptCloudTurn({
    agentId, conversationId, turnId, userText, userAt, engine,
    ...(answerText ? { answerText, answeredAt: isoOrNull(p.answeredAt) ?? userAt } : {}),
    ...(!answerText ? { error: typeof p.error === 'string' ? p.error.slice(0, 500) : undefined } : {}),
  });
  return { turnId, adopted: outcome === 'adopted', duplicate: outcome === 'already-present' };
}
