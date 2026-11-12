/**
 * The page's one answer to "is this server a replica answering without its leader"
 * and "does it offer capability X" (GET /api/config `role` and `capabilities`, read
 * from `cloud` on an older companion: config.ts roleFactsOf). Every surface that
 * hides a leader-only action (Retry, Connect, autofix, Build, Main's quick menus,
 * the Mac's own Settings panes) reads it through hooks/useServerRole.ts.
 *
 * The answer is re-read when the server under the page may have changed: on every
 * socket reconnect (a host replica hands the page over with a 4001/4002 close, and a
 * deploy restarts the server) and on every change of the Mac's presence. Until the
 * first answer lands the page reads the leader's facts, so the Mac keeps its buttons.
 *
 * Only a real answer is kept. A failed read used to be cached as "the leader" for the
 * page's life, so a replica page that booted during a stall showed Retry buttons that
 * could never work: the first read retries on the registry schedule, and a failed
 * re-read keeps the last answer.
 */
import { fetchServerRole, type ServerCapability, type ServerRoleFacts } from './config';
import { wsClient } from './ws';
import { getLeaderPresence, subscribeLeaderPresence } from './leader-presence';
import { fetchWithRetry } from '@/utils/fetch-retry';

/** The Mac's facts, read until an answer lands (kept here, not read from config.ts, so a test's config mock never needs it). */
const LEADER_ROLE_FACTS: ServerRoleFacts = Object.freeze({ replica: false, capabilities: Object.freeze([]) as readonly string[] });

let answer: ServerRoleFacts | null = null;
/** Counts reads: only the newest one may set the answer. */
let generation = 0;
let firstLoading = false;
/** The first read ended (answered, or its retries ran out). */
let firstSettled = false;
let hooked = false;
let lastAnswers: boolean | null = null;
const listeners = new Set<() => void>();

function apply(gen: number, next: ServerRoleFacts): void {
  if (gen !== generation) return;
  const same = answer !== null && answer.replica === next.replica
    && answer.capabilities.length === next.capabilities.length
    && answer.capabilities.every((c, i) => c === next.capabilities[i]);
  if (same) return;
  answer = next;
  for (const l of listeners) l();
}

function firstLoad(): void {
  if (answer !== null || firstLoading) return;
  firstLoading = true;
  const gen = ++generation;
  fetchWithRetry(() => fetchServerRole({ strict: true }), { subsystem: 'config', label: 'server role' })
    .then((r) => apply(gen, r))
    .catch(() => { /* logged by fetchWithRetry; unknown until the next reconnect */ })
    .finally(() => {
      firstLoading = false;
      if (firstSettled) return;
      firstSettled = true;
      for (const l of listeners) l();
    });
}

/** Read again; a failure keeps what the page had. */
function reread(fresh: boolean): void {
  if (answer === null) { firstLoad(); return; }
  const gen = ++generation;
  fetchServerRole({ strict: true, fresh }).then((r) => apply(gen, r), () => { /* keep the last answer */ });
}

function hook(): void {
  if (hooked) return;
  hooked = true;
  // The shared GET drops its answer on this event before named listeners run.
  wsClient.onEvent('_ws:reconnected', () => reread(false));
  lastAnswers = getLeaderPresence().answers;
  subscribeLeaderPresence(() => {
    const answers = getLeaderPresence().answers;
    if (answers === lastAnswers) return;
    lastAnswers = answers;
    reread(true);
  });
}

export function subscribeServerRole(cb: () => void): () => void {
  listeners.add(cb);
  hook();
  firstLoad();
  return () => { listeners.delete(cb); };
}

/** The answer now (the leader's facts until one lands). */
export function getServerRole(): ServerRoleFacts {
  return answer ?? LEADER_ROLE_FACTS;
}

/**
 * null while the page's first read is on its way (a view that must not flash a
 * leader-only form on a replica waits for it); the leader's facts once it failed.
 */
export function getSettledServerRole(): ServerRoleFacts | null {
  return answer ?? (firstSettled ? LEADER_ROLE_FACTS : null);
}

/** The kept answer, or the first read's (for code outside React, e.g. the ssh prewarm). */
export function serverRoleNow(): Promise<ServerRoleFacts> {
  if (answer) return Promise.resolve(answer);
  hook();
  return fetchServerRole();
}

/** Whether this server is a replica answering without its leader. */
export function isReplicaServer(facts: ServerRoleFacts = getServerRole()): boolean {
  return facts.replica;
}

/** Whether this server offers `name` (an older companion offers all four). */
export function hasServerCapability(name: ServerCapability, facts: ServerRoleFacts = getServerRole()): boolean {
  return facts.capabilities.includes(name);
}

/** Test hook. */
export function __resetServerRoleForTests(): void {
  answer = null;
  generation = 0;
  firstLoading = false;
  firstSettled = false;
  hooked = false;
  lastAnswers = null;
  listeners.clear();
}
