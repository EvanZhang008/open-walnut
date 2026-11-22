/**
 * Approvals API client (src/web/routes/approvals-v1.ts): a script waits for the person's
 * yes. The console shows the pending ones and answers them with one tap, like every device
 * the person is signed in on (src/core/approvals/types.ts).
 */
import { apiGet, apiPost, apiPut } from './client';

/** `biometric` only in records an older Walnut wrote; every new approval is `tap`. */
export type ApprovalMode = 'tap' | 'biometric';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'canceled';

export interface Approval {
  id: string;
  what: string;
  detail?: string;
  /** `summary`: the detail is the request said in words (Walnut's own asks): shown whole, never in a fold. */
  detailRole?: 'summary';
  digest: string;
  mode: ApprovalMode;
  requester: {
    host: string; taskId?: string; taskTitle?: string; sessionId?: string; cwd?: string; command?: string;
    /** Whether Walnut saw the asking process inside that session: absent from an older server. */
    identity?: 'verified' | 'unverified' | 'none';
    /** Why unverified: looked and found it outside the session, or could not look. */
    check?: 'outside' | 'unchecked';
    /** For a request from no session: the process that ran it and the account it ran as. */
    process?: string; user?: string;
    /** The command line that ran it, read by Walnut from the process table. */
    ranBy?: string; local?: boolean; };
  /** Why it asks, the task's goal and its last steps, read when it asked (src/core/approvals/asker-context.ts). */
  context?: ApprovalContext;
  /** An approval that is used once (its detail is the envelope the asker checks). */
  singleUse?: boolean;
  /** Not asked: approvals were off (src/core/approvals/ask-me.ts); the gate's name. */
  unasked?: string;
  /** An ask the Approvals switch never answers: no "stop asking me" on it. */
  outsideSwitch?: boolean;
  createdAt: string;
  expiresAt: string;
  status: ApprovalStatus;
  answer?: { decision: 'approve' | 'deny'; at: string; mode: ApprovalMode; device: { id?: string; name: string; kind: string } };
  canceledReason?: string;
  testRun?: string;
}

export interface ApprovalContext {
  why?: string;
  whyFrom?: 'asker' | 'session';
  goal?: string;
  project?: string;
  steps?: { kind: 'ran' | 'edited' | 'said' | 'tool'; text: string }[];
  /** What the step does and why, written by Walnut when the asker gave no why (src/core/approvals/summary.ts). */
  summary?: string;
}

export function listApprovals(status: 'pending' | 'all' = 'pending'): Promise<{ approvals: Approval[]; askMe?: boolean }> {
  return apiGet('/api/v1/approvals', status === 'all' ? { status } : undefined, { quietStatuses: [404, 503] });
}

export interface AnswerBody {
  decision: 'approve' | 'deny';
  /** The digest of the request this window showed: the server refuses the answer (409) if it changed since. */
  digest?: string;
  device?: { name: string; kind: 'mac-app' | 'web' };
}

export function answerApproval(id: string, body: AnswerBody): Promise<{ approval: Approval }> {
  return apiPost(`/api/v1/approvals/${encodeURIComponent(id)}/answer`, body, { quietStatuses: [403, 409] });
}

/** The Approvals switch's name wherever the person reads it (Settings, General, and the card's way there). */
export const APPROVALS_SWITCH_LABEL = 'Ask me before outward or sensitive steps';

/**
 * The person's one Approvals switch (Settings, General: APPROVALS_SWITCH_LABEL;
 * src/core/approvals/ask-me.ts). Off: agents' steps go ahead with no card, each logged. Only a
 * person's own window changes it (routes/config.ts): an agent's call is refused.
 */
export function setApprovalsAskMe(askMe: boolean): Promise<unknown> {
  return apiPut('/api/config', { approvals: { ask_me: askMe } });
}
