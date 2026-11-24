import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

describe('voice archive control deadline', () => {
  it('extends only the archive transcription in the daemon transport', async () => {
    // The daemon's control relay (daemon-bridge-relays.ts, moved out of daemon-standalone.ts).
    const relays = await readFile(new URL('../../src/providers/daemon-bridge-relays.ts', import.meta.url), 'utf8')
    expect(relays).toContain("action === 'server.voice.archive' && params?.operation === 'transcribe' ? 900_000 : CONTROL_RELAY_TIMEOUT_MS")
  })
})
