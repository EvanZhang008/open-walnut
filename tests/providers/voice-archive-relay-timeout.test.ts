import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

describe('voice archive control deadline', () => {
  it('extends only the archive transcription in the daemon transport', async () => {
    const standalone = await readFile(new URL('../../src/providers/daemon-standalone.ts', import.meta.url), 'utf8')
    expect(standalone).toContain("action === 'server.voice.archive' && params?.operation === 'transcribe' ? 900_000 : CONTROL_RELAY_TIMEOUT_MS")
  })
})
