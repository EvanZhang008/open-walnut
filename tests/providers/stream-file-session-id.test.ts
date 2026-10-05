/**
 * The server's startup stream cleanup keeps every file of a live session. It
 * used to recognise only `.jsonl`, `.jsonl.err` and `.pipe`, so a live
 * session's `.jsonl.fold` checkpoint older than an hour was deleted at every
 * server start, which a deploy does right before it upgrades the daemon, and
 * the new daemon folded that whale stream from byte 0 again.
 */
import { describe, it, expect } from 'vitest'
import { streamFileSessionId } from '../../src/providers/claude-code-session.js'

const SID = 'a4da7628-4924-4047-854f-d9f5f498c615'

describe('streamFileSessionId', () => {
  it('maps the stream and every daemon sidecar to its session id', () => {
    for (const ext of ['.jsonl', '.jsonl.err', '.jsonl.fold', '.jsonl.lines', '.pipe', '.pgid', '.log']) {
      expect(streamFileSessionId(SID + ext), ext).toBe(SID)
    }
  })

  it('leaves names that are not a sidecar of a session alone', () => {
    // A crashed checkpoint write's temp file is debris, not the checkpoint.
    expect(streamFileSessionId(SID + '.jsonl.fold.tmp-123')).not.toBe(SID)
    expect(streamFileSessionId('acp-x.acp.jsonl')).toBe('acp-x.acp')
    expect(streamFileSessionId('README')).toBe('README')
  })
})
