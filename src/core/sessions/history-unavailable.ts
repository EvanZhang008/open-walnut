/**
 * Why a session's history cannot be shown: one wording for the web route and
 * the session lifecycle (two copies had drifted: one named every ACP engine
 * "Codex"). A remote host is called unreachable only when it is not connected;
 * a connected host whose transcript is missing says so (2026-11-08: a session
 * on a host that had just answered read "is unreachable").
 */
import { engineCaps } from '../agents/engine-registry.js'
import type { SessionRecord } from '../types.js'

export async function unavailableHistoryReason(record: Pick<SessionRecord, 'engine' | 'host' | 'acpRuntimeId'>): Promise<string> {
  const caps = engineCaps(record.engine)
  if (caps.historySource === 'acp-journal') {
    if (!record.acpRuntimeId) {
      return `${caps.displayName} session has no ACP runtime ID, so its history journal cannot be located`
    }
    return record.host
      ? `${caps.displayName} session history journal is unavailable on remote host "${record.host}"`
      : `${caps.displayName} session history journal not found`
  }
  if (!record.host || record.host === '__local__') return 'Session history file not found'
  return (await hostConnected(record.host))
    ? `Session history file not found on "${record.host}"`
    : `Remote host "${record.host}" is unreachable — session history is stored on that machine`
}

async function hostConnected(host: string): Promise<boolean> {
  try {
    const { isDaemonConnected } = await import('../../providers/daemon-connection.js')
    return isDaemonConnected(host)
  } catch {
    return false
  }
}
