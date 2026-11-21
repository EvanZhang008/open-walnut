/**
 * One read of a subagent's JSONL file into whole lines (the daemon's agent subscription polls it).
 *
 * A daemon program reads the whole backlog in one go, as it always did. Inside a server's process a
 * read is capped (`maxBytes`) so a large backlog never holds every route at once: the read stops at
 * its last complete line, and a line longer than the cap is carried over to the next reads until its
 * newline arrives. A line is never cut in two, however long (review R2-S5, 2026-11-21: a 2 MB tool
 * result used to arrive as two halves that neither parse).
 */

export interface AgentFileState {
  offset: number
  /** Bytes of a line still waiting for its newline (capped reads only). */
  carry?: Buffer
}

/** How many bytes the next read takes: the whole backlog, or at most the cap. */
export function agentReadSize(state: AgentFileState, size: number, maxBytes: number | null): number {
  const backlog = size - state.offset
  if (backlog <= 0) return 0
  return maxBytes === null ? backlog : Math.min(backlog, maxBytes)
}

/**
 * Takes the bytes just read at `state.offset` (`chunk`, `size` being the file's size when read),
 * moves the offset past them and returns the non-blank lines to send. An uncapped read sends what it
 * read, a trailing partial line included (a daemon program's behaviour); a capped read keeps the
 * unfinished line in `state.carry` while more of the file is still unread.
 */
export function takeAgentLines(state: AgentFileState, chunk: Buffer, size: number): string[] {
  state.offset += chunk.length
  const data = state.carry ? Buffer.concat([state.carry, chunk]) : chunk
  state.carry = undefined
  let used = data.length
  if (state.offset < size) {
    const lastNl = data.lastIndexOf(0x0a)
    used = lastNl + 1
    if (used < data.length) state.carry = Buffer.from(data.subarray(used))
  }
  if (used === 0) return []
  return data.subarray(0, used).toString('utf-8').split('\n').filter((l) => l.trim())
}
