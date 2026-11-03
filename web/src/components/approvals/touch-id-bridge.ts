/**
 * The Mac app's Touch ID signer (desktop/ApprovalBridge.swift), reached through the
 * `walnutApproval` message handler, which answers with a promise. Absent in a browser,
 * where a biometric approval is answered on the phone instead.
 *
 * The key lives in the Mac's Secure Enclave and signs only after Touch ID; the app
 * rebuilds the approval's digest from the fields it shows (core/approvals/digest.ts) and
 * refuses one that does not match, so the person signs what they read.
 */
import type { Approval } from '@/api/approvals';

interface Handler { postMessage(body: unknown): Promise<unknown> }

function handler(): Handler | null {
  const w = window as unknown as { webkit?: { messageHandlers?: Record<string, Handler | undefined> } };
  return w.webkit?.messageHandlers?.walnutApproval ?? null;
}

export interface TouchIdStatus {
  /** The app can make and use a Touch ID key here. */
  available: boolean;
  /** Why not, in a sentence the person reads. */
  reason?: string;
  keyId?: string;
  publicKey?: string;
  name?: string;
}

export function hasTouchIdBridge(): boolean {
  return handler() !== null;
}

export async function touchIdStatus(): Promise<TouchIdStatus> {
  const h = handler();
  if (!h) return { available: false, reason: 'Touch ID signing needs the Walnut Mac app.' };
  try {
    return (await h.postMessage({ op: 'status' })) as TouchIdStatus;
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Touch ID, then the signature over this approval's decision. Throws when the person cancels. */
export async function touchIdSign(approval: Approval, decision: 'approve' | 'deny'): Promise<{ keyId: string; signature: string }> {
  const h = handler();
  if (!h) throw new Error('Touch ID signing needs the Walnut Mac app.');
  const out = (await h.postMessage({
    op: 'sign',
    decision,
    approval: {
      id: approval.id, mode: approval.mode, createdAt: approval.createdAt, expiresAt: approval.expiresAt,
      host: approval.requester.host, taskId: approval.requester.taskId ?? '', what: approval.what,
      detail: approval.detail ?? '', digest: approval.digest,
    },
  })) as { keyId?: string; signature?: string; error?: string };
  if (!out?.signature || !out.keyId) throw new Error(out?.error ?? 'Not signed.');
  return { keyId: out.keyId, signature: out.signature };
}
