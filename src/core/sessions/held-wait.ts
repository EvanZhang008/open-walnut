/**
 * What a session's pending queued row waits on, for a reader that was not there when the
 * wait was told (a reloaded panel's session:get-queue): a host that did not take it in time,
 * or a host nothing reaches now, with when Walnut tries again by itself. The runner's hold
 * (noteHeld) is in memory, so after a server restart a pending row to a host whose link is
 * down now reads that wait from the link itself, never a bare "Queued".
 */

export interface HeldWait { reason: string; retryAt?: string }

export async function heldWaitOf(sessionId: string): Promise<(rowId: string, heldReason: string | undefined) => HeldWait | null> {
  const [{ isHostWaitReason, hostLinkReason }, { getSessionByClaudeId }, links] = await Promise.all([
    import('../../providers/host-wait-words.js'),
    import('../session-tracker.js'),
    import('../../providers/daemon-connection.js'),
  ])
  const runner = await import('../../providers/claude-code-session.js').then((m) => m.sessionRunner).catch(() => null)
  const host = (await getSessionByClaudeId(sessionId).catch(() => null))?.host ?? '__local__'
  // A link state that cannot be read is not "down".
  const down = (() => { try { return links.hostLinkDown(host) } catch { return false } })()
  const name = down ? await (await import('../hosts/host-display-name.js')).hostDisplayNameFor(host) : host
  return (rowId, why) => {
    if (why && isHostWaitReason(why)) {
      try { return runner?.deliveryWait(sessionId, rowId) ?? { reason: why } } catch { return { reason: why } }
    }
    if (!down) return null
    const at = (() => { try { return links.hostReconnectAt(host) } catch { return null } })()
    return { reason: hostLinkReason(name), ...(at ? { retryAt: new Date(at).toISOString() } : {}) }
  }
}
