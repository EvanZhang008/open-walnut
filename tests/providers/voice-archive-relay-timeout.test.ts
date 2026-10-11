import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

describe('voice archive control deadline parity', () => {
  it('extends only the archive transcription in both daemon transports', async () => {
    const standalone = await readFile(new URL('../../src/providers/daemon-standalone.ts', import.meta.url), 'utf8')
    const source = await readFile(new URL('../../src/providers/daemon-source.ts', import.meta.url), 'utf8')
    expect(standalone).toContain("action === 'server.voice.archive' && params?.operation === 'transcribe' ? 900_000 : CONTROL_RELAY_TIMEOUT_MS")
    expect(source).toContain("action === 'server.voice.archive' && params && params.operation === 'transcribe' ? 900000 : CONTROL_RELAY_TIMEOUT_MS")
  })
})
