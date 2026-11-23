/**
 * /api/stt/compare through the real HTTP edge: every route is inert (409
 * experimental_off) while the experiment is off; on, the engines list carries
 * each row's state and consent, settings store the ElevenLabs key as a secret
 * file with only its ${file:} reference in config, takes come with run states
 * and word diffs, and the audio is served for the user's own Play button.
 * Engines and models are fakes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const constants = vi.hoisted(() => ({ home: '' }))
vi.mock('../../../src/constants.js', async () => {
  const c = (await import('../../helpers/mock-constants.js')).createMockConstants('stt-compare-routes')
  constants.home = c.WALNUT_HOME as string
  return c
})
const state = vi.hoisted(() => ({ config: {} as Record<string, any> }))
vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: async () => structuredClone(state.config),
  updateConfig: async (partial: Record<string, Record<string, unknown>>) => {
    for (const [key, value] of Object.entries(partial)) {
      const merged = { ...(state.config[key] ?? {}), ...value }
      for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k]
      state.config[key] = merged
    }
  },
  migrateStoredConfig: async (mutate: (doc: Record<string, unknown>) => boolean) => {
    // The stored doc is the config as written; the edit lands only when mutate says it changed.
    const doc = structuredClone(state.config)
    if (await mutate(doc)) state.config = doc
    return true
  },
}))
vi.mock('../../../src/core/task-manager.js', () => ({ listTaskTitles: async () => [] }))
vi.mock('../../../src/core/stt/setup.js', () => ({ getModelDir: () => join(constants.home, 'no-models') }))
vi.mock('../../../src/core/stt/index.js', () => ({
  transcribeAudio: async () => ({ text: 'hello big world', durationMs: 3, engine: 'mlx' }),
  getOrCreateEngine: () => ({ name: 'mlx', isAvailable: async () => ({ available: true }) }),
  createEngineByName: () => null,
  loadVocabPrompt: async () => '',
}))
vi.mock('../../../src/model/model.js', () => ({ sendMessage: async () => ({ content: [{ type: 'text', text: 'hello big world' }], stopReason: 'end_turn' }) }))

import express from 'express'
import request from 'supertest'
const { sttCompareRouter } = await import('../../../src/web/routes/stt-compare.js')
const { compareStore } = await import('../../../src/core/stt/compare/store.js')
const { runIdle } = await import('../../../src/core/stt/compare/runner.js')

const app = express()
app.use(express.json())
app.use('/api/stt/compare', sttCompareRouter)

const REC = '2026-11-21T12-00-00-000Z'
beforeEach(() => { state.config = { experimental: { stt_compare: true }, stt: { engine: 'mlx' } } })

describe('/api/stt/compare', () => {
  it('every route answers 409 experimental_off while the experiment is off', async () => {
    state.config = {}
    for (const [method, path] of [['get', '/summary'], ['get', '/pairs.jsonl'], ['get', '/takes'], ['get', `/takes/rec-${REC}`], ['get', `/takes/rec-${REC}/audio`], ['get', '/engines'], ['put', '/settings'], ['post', '/run'], ['get', '/run'], ['post', `/takes/rec-${REC}/judge`], ['post', '/import-bench']] as const) {
      const res = await request(app)[method](`/api/stt/compare${path}`).send({})
      expect(res.status, `${method} ${path}`).toBe(409)
      expect(res.body).toEqual({ error: 'experimental_off' })
    }
    expect(await compareStore.count()).toBe(0)
  })

  it('lists every engine and the judge with its state; cloud rows need consent', async () => {
    const res = await request(app).get('/api/stt/compare/engines')
    expect(res.status).toBe(200)
    const byId = Object.fromEntries((res.body.engines as Array<{ id: string }>).map((e) => [e.id, e]))
    expect(Object.keys(byId)).toEqual(['in-use', 'whisper-large-v2', 'elevenlabs-scribe', 'haiku-cleanup', 'judge'])
    expect(byId['in-use']).toMatchObject({ label: 'In use: mlx', runsOn: 'local', sends: 'nothing', state: 'ready', enabled: true, allow_upload: false })
    // Its own name too, without the model in use now: earlier results are labelled by the model they recorded.
    expect(byId['in-use']).toMatchObject({ name: 'In use' })
    // Not ready: the exact path it needs, and the pane's fix (the model's download).
    expect(byId['whisper-large-v2']).toMatchObject({ state: 'not-installed', fix: 'download-whisper' })
    expect((byId['whisper-large-v2'] as { detail: string }).detail).toContain(join(constants.home, 'no-models', 'ggml-large-v2.bin'))
    // The model id is secondary detail, not part of the name.
    expect(byId['elevenlabs-scribe']).toMatchObject({ label: 'ElevenLabs Scribe', model: 'scribe_v3', runsOn: 'cloud', sends: 'audio', state: 'needs-consent' })
    expect(byId.judge).toMatchObject({ kind: 'judge', label: 'AI judge', sends: 'text', state: 'needs-consent' })
  })

  it('the clean-up is ready only when the engine whose text it cleans up is; the in-use engine names its fix', async () => {
    state.config.stt.compare = { engines: { 'haiku-cleanup': { allow_upload: true } } }
    const on = (await request(app).get('/api/stt/compare/engines')).body.engines.find((e: { id: string }) => e.id === 'haiku-cleanup')
    expect(on).toMatchObject({ state: 'ready' })
    state.config.stt.compare.engines['in-use'] = { enabled: false }
    const off = (await request(app).get('/api/stt/compare/engines')).body.engines as Array<{ id: string; state: string; detail?: string }>
    expect(off.find((e) => e.id === 'haiku-cleanup')).toMatchObject({ state: 'not-installed' })
    expect(off.find((e) => e.id === 'haiku-cleanup')!.detail).toMatch(/In use engine's text/)
  })

  it('uses the ElevenLabs key from Voice settings when none is saved here, and says where it came from', async () => {
    const before = process.env.ELEVENLABS_API_KEY
    delete process.env.ELEVENLABS_API_KEY
    try {
      const none = (await request(app).get('/api/stt/compare/engines')).body
      expect(none).toMatchObject({ hasElevenLabsKey: false, elevenLabsKeyFrom: null })
      state.config.tts = { ...(state.config.tts ?? {}), elevenlabs_api_key: 'fake-voice-key-for-tests-0007' }
      const voice = (await request(app).get('/api/stt/compare/engines')).body
      expect(voice).toMatchObject({ hasElevenLabsKey: true, elevenLabsKeyFrom: 'voice' })
      // The engine row no longer asks for a key: only the upload consent stands before it runs.
      expect((voice.engines as Array<{ id: string; state: string }>).find((e) => e.id === 'elevenlabs-scribe')!.state).toBe('needs-consent')
      expect(JSON.stringify(voice)).not.toContain('fake-voice-key-for-tests-0007')
    } finally {
      delete state.config.tts?.elevenlabs_api_key
      if (before !== undefined) process.env.ELEVENLABS_API_KEY = before
    }
  })

  it('settings: consent and switches, and the key kept as a secret file', async () => {
    const res = await request(app).put('/api/stt/compare/settings').send({
      engines: { 'elevenlabs-scribe': { allow_upload: true }, 'whisper-large-v2': { enabled: false } }, nightly: true, elevenlabs_api_key: 'fake-key-for-tests-0003',
    })
    expect(res.status).toBe(200)
    const file = join(constants.home, 'secrets', 'elevenlabs-api.key')
    expect((await readFile(file, 'utf8')).trim()).toBe('fake-key-for-tests-0003')
    expect(state.config.stt.compare).toMatchObject({ nightly: true, elevenlabs_api_key: `\${file:${file}}`, engines: { 'elevenlabs-scribe': { allow_upload: true }, 'whisper-large-v2': { enabled: false } } })
    expect(state.config.stt.engine).toBe('mlx')
    expect(JSON.stringify(res.body)).not.toContain('fake-key-for-tests-0003')
    const rows = Object.fromEntries((res.body.engines as Array<{ id: string; state: string }>).map((e) => [e.id, e.state]))
    expect(rows['whisper-large-v2']).toBe('off')
    expect(res.body).toMatchObject({ nightly: true, hasElevenLabsKey: true })
    // Bad fields are refused, and change nothing.
    expect((await request(app).put('/api/stt/compare/settings').send({ engines: { nope: { enabled: true } } })).status).toBe(400)
    expect((await request(app).put('/api/stt/compare/settings').send({ nightly: 'yes' })).status).toBe(400)
  })

  it('runs, lists the take with run states, diffs it against the reference, and serves its audio', async () => {
    const dir = join(constants.home, 'tmp', 'stt-recordings')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${REC}.webm`), Buffer.from('webm-bytes'))
    await writeFile(join(dir, `${REC}.json`), JSON.stringify({ timestamp: '2026-11-21T12:00:01.000Z', format: 'webm', result: { text: 'hello world', durationMs: 3 } }))
    state.config.stt.compare = { engines: { judge: { allow_upload: true } } }
    const run = await request(app).post('/api/stt/compare/run').send({ takeIds: [`rec-${REC}`], engines: ['in-use'] })
    expect(run.status).toBe(202)
    await runIdle()
    // The run says how many recordings it planned and how many it really compared.
    expect((await request(app).get('/api/stt/compare/run')).body).toMatchObject({ running: false, done: 1, total: 1, takes: 1, compared: 1 })
    const list = await request(app).get('/api/stt/compare/takes?limit=10')
    expect(list.body.total).toBe(1)
    expect(list.body.takes[0]).toMatchObject({ id: `rec-${REC}`, run: { 'in-use': { state: 'done' }, judge: { state: 'done' } } })
    // The fake judge says "hello big world"; the in-use text matches it.
    await compareStore.upsert(`rec-${REC}`, { results: { 'in-use': { text: 'hello world', ms: 3, at: 'x' } } })
    const one = await request(app).get(`/api/stt/compare/takes/rec-${REC}`)
    expect(one.body.reference.text).toBe('hello big world')
    expect(one.body.diffs['in-use']).toEqual([{ op: 'same', text: 'hello ' }, { op: 'missing', text: '', ref: 'big' }, { op: 'same', text: 'world' }])
    const audio = await request(app).get(`/api/stt/compare/takes/rec-${REC}/audio`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => cb(null, Buffer.concat(chunks)))
    })
    expect(audio.status).toBe(200)
    expect(audio.headers['content-type']).toBe('audio/webm')
    expect((audio.body as Buffer).toString()).toBe('webm-bytes')
    const summary = await request(app).get('/api/stt/compare/summary')
    expect(summary.body).toMatchObject({ takes: 1, judged: 1, judge: { state: 'ready' } })
    expect(summary.body.engines.map((e: { id: string }) => e.id)).toContain('in-use')
    // Each engine names the models its results were made with; this older result recorded none.
    expect(summary.body.engines.find((e: { id: string }) => e.id === 'in-use')).toMatchObject({ models: [], unrecorded: 1 })
    // Judge again is queued like a run (202), and the run's progress follows it.
    expect((await request(app).post(`/api/stt/compare/takes/rec-${REC}/judge`)).status).toBe(202)
    await runIdle()
    expect((await request(app).get(`/api/stt/compare/takes/rec-${REC}`)).body.run.judge).toEqual({ state: 'done' })
    // An engine switched off now is not in the summary, so it never shrinks the shared takes.
    state.config.stt.compare.engines['in-use'] = { enabled: false }
    const without = await request(app).get('/api/stt/compare/summary')
    expect(without.body.engines.map((e: { id: string }) => e.id)).not.toContain('in-use')
  })

  it('a take keeps what was probably sent as sent, with how it was paired, and diffs it', async () => {
    const dir = join(constants.home, 'tmp', 'stt-recordings')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${REC}.webm`), Buffer.from('webm-bytes'))
    await writeFile(join(dir, `${REC}.json`), JSON.stringify({ timestamp: '2026-11-21T12:00:01.000Z', format: 'webm', result: { text: 'hello world', durationMs: 3 } }))
    const { recordSentTextOf } = await import('../../../src/core/stt/compare/sent-text.js')
    const now = Date.now()
    const sent = '  hello big world\n'
    expect(await recordSentTextOf(sent, now, [{ text: 'hello big world', at: now - 1000, source: { kind: 'recording', id: REC } }])).toBe(true)
    await compareStore.upsert(`rec-${REC}`, { reference: { text: 'hello big world', judge: 'test-judge', at: 'x' } })
    const one = (await request(app).get(`/api/stt/compare/takes/rec-${REC}`)).body
    // Never trimmed, and marked as a pairing by text, with its similarity.
    expect(one).toMatchObject({ sentText: sent, sentMatch: 'text-similarity', sentSimilarity: 1 })
    expect(one.diffs.sent.map((d: { op: string }) => d.op)).not.toContain('changed')
  })

  it('the in-use engine on a cloud dictation engine reads as one that uploads, needing consent', async () => {
    state.config.stt.engine = 'openai'
    const res = await request(app).get('/api/stt/compare/engines')
    const inUse = (res.body.engines as Array<{ id: string }>).find((e) => e.id === 'in-use')
    expect(inUse).toMatchObject({ runsOn: 'cloud', sends: 'audio', state: 'needs-consent', allow_upload: false })
  })

  it('settings edit stt.compare only, and a cleared key removes its managed file', async () => {
    state.config.stt = { engine: 'mlx', language: 'zh', compare: { nightly: true } }
    await request(app).put('/api/stt/compare/settings').send({ elevenlabs_api_key: 'fake-key-for-tests-0004' })
    expect(state.config.stt).toMatchObject({ engine: 'mlx', language: 'zh', compare: { nightly: true } })
    // Nothing else of stt is written (no defaults filled in).
    expect(Object.keys(state.config.stt).sort()).toEqual(['compare', 'engine', 'language'])
    await request(app).put('/api/stt/compare/settings').send({ elevenlabs_api_key: '' })
    expect(state.config.stt.compare.elevenlabs_api_key).toBeUndefined()
    await expect(readFile(join(constants.home, 'secrets', 'elevenlabs-api.key'), 'utf8')).rejects.toThrow()
  })

  it('refuses a take id that names no take, and an import from a relative dir', async () => {
    expect((await request(app).get('/api/stt/compare/takes/rec-..%2F..%2Fetc')).status).toBe(404)
    expect((await request(app).get('/api/stt/compare/takes/phone-00000000-0000-4000-8000-000000000000')).status).toBe(404)
    expect((await request(app).post('/api/stt/compare/import-bench').send({ dir: 'relative/dir' })).status).toBe(400)
    expect((await request(app).post('/api/stt/compare/import-bench').send({ dir: '/nonexistent-bench-dir-for-tests' })).status).toBe(400)
  })

  it('imports only from under the data folder or the temp folder, and never quotes a file it could not read', async () => {
    const outside = await request(app).post('/api/stt/compare/import-bench').send({ dir: '/' })
    expect(outside.status).toBe(400)
    expect(outside.body.detail).toMatch(/data folder or the system temp folder/)
    const dir = await mkdtemp(join(tmpdir(), 'va-bench-route-'))
    await writeFile(join(dir, 'takes.json'), 'SECRET-LOOKING-TEXT not json')
    await writeFile(join(dir, 'results.json'), '{"per_take": []}')
    const bad = await request(app).post('/api/stt/compare/import-bench').send({ dir })
    expect(bad.status).toBe(400)
    expect(bad.body.detail).toBe('takes.json is not JSON')
    expect(JSON.stringify(bad.body)).not.toContain('SECRET-LOOKING-TEXT')
    await writeFile(join(dir, 'takes.json'), '[]')
    expect((await request(app).post('/api/stt/compare/import-bench').send({ dir })).body).toEqual({ imported: 0, unchanged: 0, skipped: [] })
  })

  it('Delete comparison data removes the takes, the key and the settings, also with the experiment off', async () => {
    await request(app).put('/api/stt/compare/settings').send({ elevenlabs_api_key: 'fake-key-for-tests-0005', nightly: true })
    await compareStore.upsert(`rec-${REC}`, { source: 'web', at: '2026-11-21T12:00:00.000Z', format: 'webm', audioRef: { kind: 'recording', id: REC } })
    state.config.experimental = {}
    const res = await request(app).post('/api/stt/compare/delete-data')
    expect(res.status).toBe(200)
    expect(await compareStore.count()).toBe(0)
    expect(state.config.stt.compare).toBeUndefined()
    expect(state.config.stt.engine).toBe('mlx')
    await expect(readFile(join(constants.home, 'secrets', 'elevenlabs-api.key'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(constants.home, 'stt-compare', 'takes', `rec-${REC}.json`), 'utf8')).rejects.toThrow()
  })

  it('judging a take without the judge\'s consent answers needs_consent', async () => {
    await compareStore.upsert(`rec-${REC}`, { source: 'web', at: '2026-11-21T12:00:00.000Z', format: 'webm', audioRef: { kind: 'recording', id: REC } })
    state.config.stt.compare = { engines: { judge: { allow_upload: false } } }
    const res = await request(app).post(`/api/stt/compare/takes/rec-${REC}/judge`)
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'needs_consent', engine: 'judge' })
  })

  it('exports the edited dictations, one JSON line each, and counts them in the summary; a shared text or one read off the message is no pair', async () => {
    const dir = join(constants.home, 'tmp', 'stt-recordings')
    await mkdir(dir, { recursive: true })
    const EDITED = '2026-11-21T13-00-00-000Z'
    const PLAIN = '2026-11-21T13-01-00-000Z'
    const SHARED = '2026-11-21T13-02-00-000Z'
    const FROM_MESSAGE = '2026-11-21T13-03-00-000Z'
    for (const id of [EDITED, PLAIN, SHARED, FROM_MESSAGE]) {
      await writeFile(join(dir, `${id}.webm`), Buffer.from('audio'))
      await writeFile(join(dir, `${id}.json`), JSON.stringify({ timestamp: '2026-11-21T13:00:00.000Z', format: 'webm', engine: 'mlx', result: { text: 'we ship on friday', durationMs: 5, engine: 'mlx', model: 'qwen3-asr' } }))
    }
    const skeleton = (id: string) => ({ source: 'web' as const, at: '2026-11-21T13:00:00.000Z', format: 'webm', audioRef: { kind: 'recording' as const, id }, inUseText: 'we ship on friday' })
    await compareStore.upsert(`rec-${EDITED}`, { ...skeleton(EDITED), sentText: 'We ship on Friday.\n', sentMatch: 'recording-id', sentSimilarity: 1, edited: true })
    await compareStore.upsert(`rec-${PLAIN}`, { ...skeleton(PLAIN), sentText: 'we ship on friday', sentMatch: 'recording-id' })
    // Two takes in one message: the text is both takes' and more, no one take's transcript.
    await compareStore.upsert(`rec-${SHARED}`, { ...skeleton(SHARED), sentText: 'We ship on Friday. And Monday too.', sentMatch: 'recording-id', sentShared: true, edited: true })
    // An older client named no box text: the message may still carry Walnut's framing.
    await compareStore.upsert(`rec-${FROM_MESSAGE}`, { ...skeleton(FROM_MESSAGE), sentText: 'We ship on Friday!', sentMatch: 'recording-id', sentFrom: 'message', edited: true })
    const res = await request(app).get('/api/stt/compare/pairs.jsonl')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/x-ndjson/)
    expect(res.headers['content-disposition']).toMatch(/attachment/)
    const lines = res.text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(lines).toEqual([{
      id: `rec-${EDITED}`, at: '2026-11-21T13:00:00.000Z', audioPath: join(dir, `${EDITED}.webm`),
      engineText: 'we ship on friday', sentText: 'We ship on Friday.\n', engine: 'mlx', model: 'qwen3-asr',
    }])
    expect((await request(app).get('/api/stt/compare/summary')).body.editedTakes).toBe(1)
  })
})
