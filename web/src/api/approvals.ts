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
  requester: { host: string; taskId?: string; taskTitle?: string; sessionId?: string; cwd?: string; command?: string };
  createdAt: string;
  expiresAt: string;
  status: ApprovalStatus;
  answer?: { decision: 'approve' | 'deny'; at: string; mode: ApprovalMode; device: { id?: string; name: string; kind: string } };
  enrollsKey?: string;
  /** A vault ask: Approve needs a device signature, or (`vault`) this window's Passwords unlock. */
  guard?: 'vault' | 'vault-sensitive';
  canceledReason?: string;
  testRun?: string;
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
