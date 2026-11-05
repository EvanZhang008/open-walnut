/**
 * Approvals API client (src/web/routes/approvals-v1.ts): a script waits for the person's
 * yes. The console shows the pending ones and answers them; a biometric one is signed by
 * the Mac app's Touch ID bridge (desktop/ApprovalBridge.swift) or answered on the phone.
 */
import { apiDelete, apiGet, apiPost } from './client';

export type ApprovalMode = 'tap' | 'biometric';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'canceled';

export interface Approval {
  id: string;
  what: string;
  detail?: string;
  digest: string;
  mode: ApprovalMode;
  downgraded?: string;
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
  /** A signed approval that is used once (its detail is the signed envelope). */
  singleUse?: boolean;
  createdAt: string;
  expiresAt: string;
  status: ApprovalStatus;
  answer?: { decision: 'approve' | 'deny'; at: string; mode: ApprovalMode; device: { id?: string; name: string; kind: string } };
  enrollsKey?: string;
  /**
   * Approve needs a device signature, or (`vault`, `person`) this window's Passwords unlock: a vault
   * ask, or (`person`) an agent's step in the browser that buys, sends or deletes.
   */
  guard?: 'vault' | 'vault-sensitive' | 'person';
  canceledReason?: string;
  testRun?: string;
}

export interface ApprovalContext {
  why?: string;
  whyFrom?: 'asker' | 'session';
  goal?: string;
  project?: string;
  steps?: { kind: 'ran' | 'edited' | 'said' | 'tool'; text: string }[];
}

export interface ApprovalKey {
  id: string;
  name: string;
  kind: 'iphone' | 'mac-app';
  status: 'active' | 'pending';
  createdAt: string;
  activatedAt?: string;
  lastUsedAt?: string;
  publicKey?: string;
}

export function listApprovals(status: 'pending' | 'all' = 'pending'): Promise<{ approvals: Approval[]; keys: ApprovalKey[] }> {
  return apiGet('/api/v1/approvals', status === 'all' ? { status } : undefined, { quietStatuses: [404, 503] });
}

export function listApprovalKeys(): Promise<{ keys: ApprovalKey[] }> {
  return apiGet('/api/v1/approvals/keys', undefined, { quietStatuses: [404, 503] });
}

export interface AnswerBody {
  decision: 'approve' | 'deny';
  keyId?: string;
  signature?: string;
  device?: { name: string; kind: 'mac-app' | 'web' };
  /** This window's Passwords unlock, the proof a `vault` approval needs. */
  vaultSession?: string;
}

export function answerApproval(id: string, body: AnswerBody): Promise<{ approval: Approval }> {
  return apiPost(`/api/v1/approvals/${encodeURIComponent(id)}/answer`, body, { quietStatuses: [403, 409] });
}

export function enrollApprovalKey(body: { publicKey: string; name: string; kind: 'mac-app' }): Promise<{ key: ApprovalKey; enrollment?: Approval }> {
  return apiPost('/api/v1/approvals/keys', body, { quietStatuses: [403, 404] });
}

export function removeApprovalKey(id: string): Promise<{ ok: true }> {
  return apiDelete(`/api/v1/approvals/keys/${encodeURIComponent(id)}`, { quietStatuses: [409] });
}
