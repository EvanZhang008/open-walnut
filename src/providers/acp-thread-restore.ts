/**
 * Which provider thread a cold ACP start should load first.
 *
 * When session/load fails, Walnut starts a fresh provider thread so the user's
 * message is not lost (acp-session.ts, the load_failed fallback). On 2026-10-30
 * that fallback fired for a reason that was Walnut's own (Codex 0.166 refused
 * the thread's model provider), and the session lost its conversation: the
 * fresh thread knew nothing, its first turn failed the same way, and every
 * later start loaded the empty thread again. The thread that holds the
 * conversation was still on disk.
 *
 * The rule, read from the runtime's own journal (a Walnut-owned file): when the
 * thread a start would load was CREATED in this journal after another thread
 * was in use, and the provider never answered in it (no finished turn, no
 * message, no tool call), the earlier thread is still the conversation, so a
 * start tries it first. A fresh thread the provider worked in is the
 * conversation, even when its turn ended in an error, and is loaded as before.
 * A start that loads the earlier thread appends `session-loaded` for it, so the
 * rule does not fire again.
 */
import fs from 'node:fs'
import readline from 'node:readline'

const META_MARKERS = ['"session-created"', '"session-loaded"', '"turn-ended"']
/** Provider frames that mean the provider worked in a thread. */
const OUTPUT_MARKERS = ['"agent_message_chunk"', '"agent_thought_chunk"', '"tool_call"', '"tool_call_update"']
const SESSION_ID_RE = /"sessionId":"([^"]+)"/

/**
 * One pass over the journal, a line at a time, keeping only per-thread facts:
 * the frame flood is skipped by substring before any parse.
 */
class ThreadFold {
  /** Thread switches in order: how each was named (minted or loaded). */
  private readonly switches: Array<{ type: 'session-created' | 'session-loaded'; id: string }> = []
  private readonly first = new Map<string, 'session-created' | 'session-loaded'>()
  /** Threads the provider answered in: a finished turn, a message, a tool call. */
  private readonly worked = new Set<string>()
  private current: string | undefined

  line(line: string): void {
    if (line.includes('"kind":"acp"')) {
      if (!OUTPUT_MARKERS.some((m) => line.includes(m))) return
      const id = SESSION_ID_RE.exec(line)?.[1]
      if (id) this.worked.add(id)
      return
    }
    // Only meta lines name threads and turn ends.
    if (!line.includes('"kind":"meta"') || !META_MARKERS.some((m) => line.includes(m))) return
    let rec: { kind?: string; event?: { type?: string; providerSessionId?: unknown } }
    try { rec = JSON.parse(line) } catch { return }
    const ev = rec.event
    if (rec.kind !== 'meta' || !ev) return
    if (ev.type === 'session-created' || ev.type === 'session-loaded') {
      if (typeof ev.providerSessionId !== 'string' || !ev.providerSessionId) return
      const id = ev.providerSessionId
      if (!this.first.has(id)) this.first.set(id, ev.type)
      this.switches.push({ type: ev.type, id })
      this.current = id
    } else if (ev.type === 'turn-ended' && this.current) {
      // A cancelled turn counts too: the provider ran it and the user saw its output.
      this.worked.add(this.current)
    }
  }

  restoreFor(requested: string): string | null {
    // Loaded (not minted) here, never seen, or worked in: load it as asked.
    if (this.first.get(requested) !== 'session-created' || this.worked.has(requested)) return null
    let at = -1
    for (let i = this.switches.length - 1; i >= 0; i--) {
      if (this.switches[i].id === requested) { at = i; break }
    }
    // Loaded back since it was minted (a restore that failed and fell back to
    // it, or any start after): it is in use, never undone in a loop.
    if (at < 0 || this.switches[at].type !== 'session-created') return null
    // The thread in use before it, passing over other minted threads the
    // provider never worked in (a fallback after a fallback): the first that is
    // a conversation, by the provider's work or by being loaded here.
    let fallback: string | null = null
    for (let i = at - 1; i >= 0; i--) {
      const id = this.switches[i].id
      if (id === requested) continue
      fallback ??= id
      if (this.worked.has(id) || this.first.get(id) === 'session-loaded') return id
    }
    return fallback
  }
}

/**
 * The thread to load before `requested`, or null to load `requested` as usual.
 * Pure: the journal's text in, a provider thread id out.
 */
export function replacedThreadToRestore(journalText: string, requested: string): string | null {
  const fold = new ThreadFold()
  for (const line of journalText.split('\n')) fold.line(line)
  return fold.restoreFor(requested)
}

/**
 * The journal-reading half, for the daemon's start path: streamed, so a long
 * journal never holds the daemon's loop in one piece. Never throws.
 */
export async function findThreadToRestore(journalPath: string, requested: string | undefined): Promise<string | null> {
  if (!requested) return null
  try {
    const fold = new ThreadFold()
    const lines = readline.createInterface({ input: fs.createReadStream(journalPath, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of lines) fold.line(line)
    return fold.restoreFor(requested)
  } catch {
    return null
  }
}
