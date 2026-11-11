/**
 * First-run setup (src/web/routes/first-run.ts): the questions this install still asks,
 * and the person's answer to one. 404 is an older server with no such route: it asks nothing.
 */
import { apiGet, apiPost } from './client';

export type FirstRunStep = 'hosts';

export async function fetchFirstRunPending(): Promise<FirstRunStep[]> {
  const res = await apiGet<{ pending?: FirstRunStep[] }>('/api/first-run', undefined, { quietStatuses: [404] });
  return Array.isArray(res.pending) ? res.pending : [];
}

export async function answerFirstRun(step: FirstRunStep): Promise<FirstRunStep[]> {
  const res = await apiPost<{ pending?: FirstRunStep[] }>('/api/first-run/answer', { step }, { quietStatuses: [404] });
  return Array.isArray(res.pending) ? res.pending : [];
}

/**
 * Open the hosts question again (Settings › Remote Hosts › Add host › Pick from your
 * SSH config). It answers nothing: the dialog it opens only adds hosts.
 */
export const FIRST_RUN_OPEN_EVENT = 'walnut:first-run-open';
export function openFirstRunHosts(): void {
  window.dispatchEvent(new CustomEvent(FIRST_RUN_OPEN_EVENT, { detail: { step: 'hosts' } }));
}

/**
 * "Add a machine that is not listed": the dialog closes and Settings › Remote Hosts opens
 * a new SSH row. The section may mount after the event, so the ask waits here until it
 * reads it (takeAddSshRequest).
 */
export const ADD_SSH_HOST_EVENT = 'walnut:remote-hosts-add-ssh';
/** The ask holds this long: a navigation that never reached Settings leaves no stray row for a later visit. */
const ADD_SSH_TTL_MS = 30_000;
let addSshAskedAt = 0;
export function requestAddSshHost(): void {
  addSshAskedAt = Date.now();
  window.dispatchEvent(new CustomEvent(ADD_SSH_HOST_EVENT));
}
export function takeAddSshRequest(): boolean {
  const was = addSshAskedAt > 0 && Date.now() - addSshAskedAt < ADD_SSH_TTL_MS;
  addSshAskedAt = 0;
  return was;
}

/**
 * "Join a machine with a link" from a host row that cannot be set up over SSH (a Mac): Settings ›
 * Remote Hosts opens its join link, the same as Add host › Join a machine with a link.
 */
export const JOIN_HOST_EVENT = 'walnut:remote-hosts-join';
export function requestJoinWithLink(): void {
  window.dispatchEvent(new CustomEvent(JOIN_HOST_EVENT));
}

/** The key this machine's ssh signs in to a host with (GET /api/hosts/:host/ssh-key); null when unknown. */
export async function fetchSshKey(host: string): Promise<{ path: string; exists: boolean } | null> {
  const res = await apiGet<{ key?: { path: string; exists: boolean } | null }>(`/api/hosts/${encodeURIComponent(host)}/ssh-key`, undefined, { quietStatuses: [404] });
  return res.key ?? null;
}
