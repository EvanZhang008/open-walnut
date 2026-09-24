/**
 * The cloud companion's OWN chat lane: "one conversation ⇄ one long-lived Claude
 * Code session on the companion", used only when the primary provably cannot
 * receive a phone turn (routes/cloud-chat-fallback.ts).
 *
 * Same shape as the primary's Personal AI lane (personal-ai-lane.ts), with four
 * deliberate differences, each forced by where this lane runs:
 *
 *  1. A DIFFERENT lane key (`cloud-chat:<agent>:<conv>`) in the companion's own,
 *     machine-local session registry. It can never be mistaken for the primary's
 *     `chat:` lane: parseLaneKey rejects it, and the projection excludes lanes.
 *  2. A cwd under the first `cloud.exec.cwd_roots` entry (`<root>/chat`), never
 *     the git-synced data tree. Reading the data tree from a companion session is
 *     how a stray file write would ride git-sync back to the Mac.
 *  3. A restrictive, non-interactive tool posture: no Walnut MCP server (on a
 *     replica its loopback calls 401), mode `dontAsk` (anything not pre-approved
 *     is denied without a prompt nobody could answer), only the web tools
 *     pre-approved (reads stay confined to the working directory, see below),
 *     and the built-in set cut to read and web tools, so no shell exists at all.
 *  4. The catch-up high-water mark lives in a machine-local sidecar under
 *     `cache/`, never in the conversation file (one writer: the primary).
 *
 * The conversation's history is still the context: the mint seeds the spawn
 * profile from the companion's synced copy of the conversation (buildLaneProfile),
 * and each later send prepends the turns the Mac answered since (buildLaneCatchUp
 * with this lane's own label and mark). That copy holds EVERY entry the primary
 * persisted: phone turns (the user row plus the `lane:<sid>` answer) and the web
 * chat's compat copies (answer unstamped), all foreign to this lane. What it does
 * not hold is a turn typed into a session panel on the Mac (the Ask Walnut slot):
 * that sender only bumps the index, and the turn lives in the Mac's CLI transcript.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME, validateAgentId } from '../../constants.js';
import { bus, EventNames } from '../event-bus.js';
import { getConfig } from '../config-manager.js';
import { withFileLock } from '../../utils/file-lock.js';
import { writeJsonFile } from '../../utils/fs.js';
import type { SessionProfile } from '../types.js';
import type { LaneSession } from './personal-ai-lane.js';
import { log } from '../../logging/index.js';

/**
 * Tools a companion chat turn may use without asking; under `dontAsk` everything
 * else is denied. Read, Glob and Grep are deliberately NOT listed: the CLI already
 * allows them inside the working directory on its own, and a whole-tool allow
 * rule would widen them to every path on the box, the data folder (device
 * tokens, keys) included, with WebFetch right there as a way out.
 */
export const CLOUD_CHAT_ALLOWED_TOOLS = ['WebSearch', 'WebFetch'];

/**
 * The ONLY built-in tools a companion chat turn can see (`--tools`). This is what
 * makes "no shell" true: `dontAsk` plus an allow list still leaves the CLI's own
 * auto-approved read-only Bash (`pwd`, `ls`, `cat` in the cwd, network probes),
 * and with WebFetch approved, injected page content could use that to send data
 * out. An allowlist of what EXISTS also keeps out Agent (a subagent would inherit
 * those auto-approvals), PowerShell, and any shell-like tool a later CLI adds.
 */
export const CLOUD_CHAT_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

/** The subdirectory of the first cloud-exec root the lane runs in. */
const CLOUD_CHAT_CWD_NAME = 'chat';

/** Machine-local bookkeeping: lane session → catch-up high-water mark. */
const MARKS_FILE = path.join(WALNUT_HOME, 'cache', 'cloud-chat-lanes.json');

/**
 * What the model is told about where it is running. One short block, placed
 * between the persona and the conversation seed so it outranks the persona's
 * "use your Walnut tools" guidance without burying the conversation.
 */
export const CLOUD_CHAT_NOTE = `## Answering from the cloud companion

The user's primary Walnut box (their Mac) is unreachable right now, so Walnut's cloud companion is answering this turn instead. Walnut's own tools (tasks, notes, memory, sessions, the walnut CLI) are NOT available here, and neither is a shell or file editing: you can read files in your working directory and search or fetch the web. When a request needs the user's Walnut data or their Mac, say briefly that it has to wait until the Mac is back, and help with everything else. This turn is saved and handed to the Mac when it reconnects.`;

/** The lane key a companion-answered conversation is bound to. */
export function cloudChatLaneKey(agentId: string, conversationId: string): string {
  return `cloud-chat:${encodeURIComponent(validateAgentId(agentId))}:${conversationId}`;
}

/** True when `child` is `parent` or lies inside it (normalized, segment-anchored). */
function isWithin(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

export type CloudChatCwd = { ok: true; cwd: string } | { ok: false; reason: string };

/**
 * `<first cloud-exec root>/chat`, created on demand. Refused when it would land
 * inside the data tree (an operator who listed the data folder itself as a root).
 */
export async function resolveCloudChatCwd(cwdRoots: string[]): Promise<CloudChatCwd> {
  const root = cwdRoots[0];
  if (!root) return { ok: false, reason: 'no cloud exec working-directory root is configured' };
  const cwd = path.join(root, CLOUD_CHAT_CWD_NAME);
  if (isWithin(cwd, WALNUT_HOME)) {
    return { ok: false, reason: 'the first cloud exec root is inside the Walnut data folder' };
  }
  try {
    await fsp.mkdir(cwd, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `the chat working directory could not be created (${err instanceof Error ? err.message : String(err)})` };
  }
  return { ok: true, cwd };
}

/**
 * The lane persona, re-postured for the companion: Walnut MCP removed, the web
 * tools pre-approved, the built-in tools cut to CLOUD_CHAT_TOOLS, and the cloud
 * note placed ahead of the seed.
 */
export function toCloudChatProfile(profile: SessionProfile, seedHeader: string): SessionProfile {
  const { walnut: _walnut, ...otherServers } = profile.mcpServers ?? {};
  const prompt = profile.systemPrompt ?? '';
  const at = prompt.lastIndexOf(seedHeader);
  const systemPrompt = at < 0
    ? `${prompt.trimEnd()}\n\n${CLOUD_CHAT_NOTE}`
    : `${prompt.slice(0, at).trimEnd()}\n\n${CLOUD_CHAT_NOTE}\n\n${prompt.slice(at)}`;
  const out: SessionProfile = {
    ...profile, systemPrompt, allowedTools: [...CLOUD_CHAT_ALLOWED_TOOLS], tools: [...CLOUD_CHAT_TOOLS],
  };
  if (Object.keys(otherServers).length > 0) out.mcpServers = otherServers;
  else delete out.mcpServers;
  return out;
}

// ── Sidecar marks ──

type MarksFile = Record<string, { mark: string; lane: string; updatedAt: string }>;

async function readMarks(): Promise<MarksFile> {
  try {
    const raw = JSON.parse(await fsp.readFile(MARKS_FILE, 'utf-8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as MarksFile : {};
  } catch {
    return {};
  }
}

/** This lane's catch-up high-water mark, or undefined when none was recorded. */
export async function readCloudLaneMark(sessionId: string): Promise<string | undefined> {
  const entry = (await readMarks())[sessionId];
  return typeof entry?.mark === 'string' ? entry.mark : undefined;
}

/** Record how far this lane has been caught up. Never moves backward. */
export async function recordCloudLaneMark(sessionId: string, lane: string, mark: string): Promise<void> {
  await withFileLock(MARKS_FILE, async () => {
    const marks = await readMarks();
    const current = marks[sessionId]?.mark;
    if (current !== undefined && mark <= current) return;
    marks[sessionId] = { mark, lane, updatedAt: new Date().toISOString() };
    await writeJsonFile(MARKS_FILE, marks);
  });
}

// ── Resolve / mint ──

/** One in-flight resolve per lane (same reason as personal-ai-lane's map). */
const inFlight = new Map<string, Promise<LaneSession>>();

/**
 * Resolve (or create) the companion lane for this conversation. `firstMessage`
 * rides the spawn when it mints; honor `created` and do not send it again.
 */
export function getOrCreateCloudChatLane(
  agentId: string,
  conversationId: string,
  cwd: string,
  firstMessage: string,
): Promise<LaneSession> {
  const lane = cloudChatLaneKey(agentId, conversationId);
  const pending = inFlight.get(lane);
  if (pending) return pending;
  const promise = resolveCloudChatLane(lane, agentId, conversationId, cwd, firstMessage)
    .finally(() => { inFlight.delete(lane); });
  inFlight.set(lane, promise);
  return promise;
}

async function resolveCloudChatLane(
  lane: string,
  agentId: string,
  conversationId: string,
  cwd: string,
  firstMessage: string,
): Promise<LaneSession> {
  const { getSessionByLane, createSessionRecord } = await import('../session-tracker.js');
  const existing = await getSessionByLane(lane);
  if (existing) {
    log.session.info('cloud chat lane: reusing session', {
      lane, sessionId: existing.claudeSessionId, processStatus: existing.process_status,
    });
    return { sessionId: existing.claudeSessionId, created: false, engine: 'claude' };
  }

  const config = await getConfig();
  const { buildLaneProfile } = await import('./personal-ai-lane.js');
  const {
    CONVERSATION_SEED_HEADER, CATCH_UP_BANNER_OPEN, CATCH_UP_BANNER_CLOSE, buildConversationSeed,
  } = await import('../chat-history.js');
  // The seed is read from THIS box's synced copy of the conversation: read-only,
  // and the only history the companion has while the primary is unreachable.
  const { profile: base, effort, seed } = await buildLaneProfile(config, agentId, { conversationId });
  const profile = toCloudChatProfile(base, CONVERSATION_SEED_HEADER);
  const sessionId = crypto.randomUUID();

  // Same two carriers as the primary lane: the profile when the recap fits the
  // argv, otherwise the first message (stdin has no ceiling).
  const seedInProfile = !!seed && (seed.text !== '' || seed.stats.turnsTotal === 0);
  let message = firstMessage;
  let mark: string | null = seedInProfile ? (seed?.watermark ?? '') : null;
  if (!seedInProfile && firstMessage) {
    const recap = await buildConversationSeed(agentId, conversationId).catch(() => null);
    if (recap?.text) {
      message = `${CATCH_UP_BANNER_OPEN}\n${recap.text}\n${CATCH_UP_BANNER_CLOSE}\n\n${firstMessage}`;
      mark = recap.watermark;
    }
  }

  const title = agentId === 'general' ? 'Cloud chat' : `Cloud chat (${agentId})`;
  await createSessionRecord(sessionId, '', '', cwd, {
    title,
    profile,
    lane,
    effort,
    mode: 'dontAsk',
    initialProcessStatus: 'idle',
    initialStatusReason: 'awaiting_spawn',
  });
  // The mark is written BEFORE the spawn, not after: the caller binds its SSE
  // relay to this id only once we return, so any await between the emit and the
  // return is a window in which the CLI's first frames go unrelayed.
  if (mark !== null) {
    await recordCloudLaneMark(sessionId, lane, mark).catch((err) => {
      log.session.warn('cloud chat lane: recording the seed mark failed', {
        lane, sessionId, error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  bus.emit(EventNames.SESSION_START, {
    taskId: '',
    message,
    cwd,
    title,
    profile,
    lane,
    effort,
    mode: 'dontAsk',
    preassignedSessionId: sessionId,
  }, ['session-runner'], { source: 'cloud-chat-lane' });
  log.session.info('cloud chat lane: session created', {
    lane, sessionId, agentId, conversationId, cwd,
    seedCarrier: seedInProfile ? 'profile' : (message !== firstMessage ? 'message' : 'none'),
    seedTurns: seed?.stats.turnsKept ?? 0,
  });
  return { sessionId, created: true, engine: 'claude' };
}

/**
 * Context for a send into an EXISTING companion lane: the turns another engine
 * (the Mac's lane) answered since this lane's mark. Never throws; a lane that
 * answers without the recap beats a send that failed on it.
 */
export async function cloudChatLaneCatchUp(
  agentId: string,
  conversationId: string,
  sessionId: string,
  message: string,
): Promise<{ message: string; commit?: () => Promise<void> }> {
  try {
    const {
      buildLaneCatchUp, cloudEngineLabel, CONVERSATION_SEED_HEADER, CATCH_UP_BANNER_OPEN, CATCH_UP_BANNER_CLOSE,
    } = await import('../chat-history.js');
    const lane = cloudChatLaneKey(agentId, conversationId);
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    let recordOnce: Promise<{ profile?: { systemPrompt?: string }; startedAt?: string } | null> | undefined;
    const record = () => (recordOnce ??= getSessionByClaudeId(sessionId).catch(() => null));
    const catchUp = await buildLaneCatchUp({
      agentId, conversationId,
      laneLabel: cloudEngineLabel(sessionId),
      readMark: () => readCloudLaneMark(sessionId),
      seededAtMint: async () => !!(await record())?.profile?.systemPrompt?.includes(CONVERSATION_SEED_HEADER),
      laneSeededAt: async () => (await record())?.startedAt ?? '',
      // Every answer in the synced file that is not stamped `cloud:<this sid>`
      // came from somewhere else, the web chat's unstamped copies included.
      unstampedIsForeign: true,
    });
    if (!catchUp) return { message };
    const commit = (): Promise<void> => recordCloudLaneMark(sessionId, lane, catchUp.watermark);
    if (!catchUp.text) return { message, commit };
    log.session.info('cloud chat lane: injecting turns this lane has not seen', {
      sessionId, agentId, conversationId, turns: catchUp.stats.turnsKept,
    });
    return { message: `${CATCH_UP_BANNER_OPEN}\n${catchUp.text}\n${CATCH_UP_BANNER_CLOSE}\n\n${message}`, commit };
  } catch (err) {
    log.session.warn('cloud chat lane: building the catch-up failed', {
      sessionId, agentId, conversationId, error: err instanceof Error ? err.message : String(err),
    });
    return { message };
  }
}
