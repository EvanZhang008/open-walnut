/**
 * Current task routing rules for a Main or lead session spawned before them.
 *
 * A cold resume replays the spawn-time prompt byte for byte and a live CLI never
 * rereads one, so an older Main or lead keeps the old "hand work to the area's
 * owner" rule. Such a session gets the rules once, as a leading notice on the
 * first stdin line frozen after this (session-message-queue.ts markProcessing /
 * markNextProcessing): the frozen bytes are what reaches the CLI, and a retry
 * keeps them. It is recorded as told (`taskRoutingNoted`) against that prompt and
 * the last compaction boundary, the way place notices are: a compaction may drop
 * it from the context, so a new boundary makes it due again (and the compaction
 * hook restates it at once). Best effort: nothing here ever fails a send.
 */

import { createHash } from 'node:crypto';
import { TASK_ROUTING_CONTRACT } from '../task-routing-contract.js';
import { createEnvelopeKit } from '../peers/envelope-kit.js';
import { isAcpEngine, resolveEngine } from '../agents/engine-registry.js';
import { log } from '../../logging/index.js';
import type { SessionRecord, Task } from '../types.js';

const kit = createEnvelopeKit();
const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const VERSION = hash(TASK_ROUTING_CONTRACT);
const NOTICE_ATTRS = { from: 'Walnut', outcome: 'task-routing-policy', note: 'current product rules, not a work request' };
const NOTICE_OPENING = '<walnut-message kind="notification" from="Walnut" outcome="task-routing-policy"';

type RoutingRecord = Pick<SessionRecord, 'appliedAppendSystemPrompt' | 'engine' | 'lastCompactUuid' | 'taskRoutingNoted'>;

/** The notice a session should get, or null. `ignoreTold`: the caller restates it whatever was said before. */
export function taskRoutingPolicyFor(record: RoutingRecord, task: Pick<Task, 'org_role'>, opts?: { ignoreTold?: boolean }): string | null {
  if (task.org_role !== 'main' && task.org_role !== 'lead') return null;
  // ACP rebuilds its instructions from buildSessionContext at every establish.
  if (isAcpEngine(resolveEngine(record.engine))) return null;
  const prompt = record.appliedAppendSystemPrompt;
  // Unknown spawn prompt (never stored, or over the size cap): treat it as current.
  if (prompt === undefined || prompt === null) return null;
  if (prompt.includes(TASK_ROUTING_CONTRACT)) return null;
  const noted = record.taskRoutingNoted;
  if (!opts?.ignoreTold && noted && noted.version === VERSION && noted.promptHash === hash(prompt)
      && (noted.compactUuid ?? '') === (record.lastCompactUuid ?? '')) return null;
  return kit.buildWalnutMessage({
    kind: 'notification',
    attrs: NOTICE_ATTRS,
    body: 'These current product rules replace older instructions to route new work by project or area. '
      + 'Use them for the request below; this notice itself starts no work.\n\n' + TASK_ROUTING_CONTRACT,
  });
}

/** A slash command must reach the CLI as typed: only raw input starting with "/" runs as one. */
export function isSlashCommandText(text: string): boolean {
  return text.trimStart().startsWith('/');
}

export function withTaskRoutingPolicy(text: string, policy: string | null): string {
  if (!policy || isSlashCommandText(text)) return text;
  let rest = text.trimStart();
  while (rest.startsWith('<walnut-message ')) {
    const end = rest.indexOf('</walnut-message>');
    if (end < 0) break;
    if (rest.slice(0, end + '</walnut-message>'.length) === policy) return text;
    rest = rest.slice(end + '</walnut-message>'.length).trimStart();
  }
  return `${policy}\n\n${text}`;
}

/** The text without a routing notice leading it (a line handed to a session spawned on the current prompt). */
export function stripTaskRoutingNotice(text: string): string {
  const rest = text.trimStart();
  if (!rest.startsWith(NOTICE_OPENING)) return text;
  const end = rest.indexOf('</walnut-message>');
  return end < 0 ? text : rest.slice(end + '</walnut-message>'.length).trimStart();
}

export interface PendingTaskRouting {
  text: string;
  /**
   * Inside the queue lock: the text with the notice leading it, or the text
   * unchanged (a slash command, one that already leads with it, or a line
   * frozen in the last minute already carries it). Claims the notice.
   */
  apply(text: string): string;
}

/**
 * Notices frozen into a line not yet delivered: two freezes racing into one
 * session carry it once. A claim lapses, so a line that never reached the CLI
 * (a stop parked it, the user discarded it) leaves the notice to a later one.
 */
const claims = new Map<string, { key: string; at: number }>();
const CLAIM_MS = 60_000;

type Noted = NonNullable<SessionRecord['taskRoutingNoted']>;
function notedOf(record: RoutingRecord, extra?: Partial<Noted>): Noted {
  return { version: VERSION, promptHash: hash(record.appliedAppendSystemPrompt ?? ''),
    ...(record.lastCompactUuid ? { compactUuid: record.lastCompactUuid } : {}), ...extra };
}

async function recordTold(sessionId: string, noted: Noted): Promise<void> {
  const { updateSessionRecordConditionally } = await import('../session-tracker.js');
  await updateSessionRecordConditionally(sessionId, { taskRoutingNoted: noted }, () => true, { preserveLastActiveAt: true })
    .catch((error) => log.session.warn('Task routing rules: could not record them as told', { sessionId, error: String(error) }));
}

async function lookup(sessionId: string): Promise<{ record: SessionRecord; text: string } | null> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const record = await getSessionByClaudeId(sessionId);
  if (!record?.taskId) return null;
  const { listTasksByIds } = await import('../task-manager.js');
  const [task] = await listTasksByIds([record.taskId]);
  if (!task) return null;
  const text = taskRoutingPolicyFor(record, task);
  return text ? { record, text } : null;
}

/** The notice the next frozen line into this session should carry, or null. Never throws. */
export async function taskRoutingPolicyForSession(sessionId: string): Promise<PendingTaskRouting | null> {
  try {
    const found = await lookup(sessionId);
    if (!found) return null;
    const { text } = found;
    const key = JSON.stringify(notedOf(found.record));
    return {
      text,
      apply: (input) => {
        const claim = claims.get(sessionId);
        if (claim && claim.key === key && Date.now() - claim.at < CLAIM_MS) return input;
        const out = withTaskRoutingPolicy(input, text);
        if (out !== input) claims.set(sessionId, { key, at: Date.now() });
        return out;
      },
    };
  } catch (error) {
    log.session.warn('Task routing rules could not be checked', { sessionId, error: String(error) });
    return null;
  }
}

/**
 * Lines that reached the CLI (session-message-queue.ts removeProcessed): one
 * led by the current notice records the session as told. Never throws.
 */
export async function noteTaskRoutingDelivered(sessionId: string, messages: string[]): Promise<void> {
  if (!messages.some((m) => m.trimStart().startsWith(NOTICE_OPENING))) return;
  try {
    const found = await lookup(sessionId);
    if (!found || !messages.some((m) => m.trimStart().startsWith(found.text))) return;
    claims.delete(sessionId);
    await recordTold(sessionId, notedOf(found.record));
  } catch (error) {
    log.session.warn('Task routing rules: delivery not recorded', { sessionId, error: String(error) });
  }
}

/**
 * The compaction hook restated the rules: told for the boundary it answers,
 * which the server may record before or after (place-notice.ts notePlaceCompaction
 * carries a fresh hook statement onto the new boundary). Never throws.
 */
export async function noteTaskRoutingStatedByHook(record: SessionRecord): Promise<void> {
  try {
    await recordTold(record.claudeSessionId, notedOf(record, { byHookAt: new Date().toISOString() }));
  } catch { /* told again on the next line */ }
}

/**
 * The host slice's view (host-slice.ts): the notice and a key naming this "due"
 * (rules version, prompt, compaction), only while the session is not told. The
 * host delivers same-host messages itself (offline-host-core.ts handleLocal), so
 * it adds the notice once per key and journals the key with that delivery.
 */
export function taskRoutingForHost(record: RoutingRecord, task: Pick<Task, 'org_role'>): { policy: string; due: string } | null {
  const policy = taskRoutingPolicyFor(record, task);
  return policy ? { policy, due: hash(JSON.stringify(notedOf(record))) } : null;
}

/** A host journaled a delivery led by the notice under `due`: told, if that is still what was due. Never throws. */
export async function noteTaskRoutingToldByHost(sessionId: string, due: string): Promise<void> {
  try {
    const found = await lookup(sessionId);
    if (!found || hash(JSON.stringify(notedOf(found.record))) !== due) return;
    claims.delete(sessionId);
    await recordTold(sessionId, notedOf(found.record));
  } catch (error) {
    log.session.warn('Task routing rules: host delivery not recorded', { sessionId, error: String(error) });
  }
}
