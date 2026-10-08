/**
 * The search wiring starts the embedding model's worker processes through the
 * utility QoS clamp when the deploy raised the server above that band
 * (src/core/search/wiring.ts buildEmbedderConfig, src/lib/background-qos.ts),
 * and forks them plainly otherwise.
 *
 * End to end through the real index singleton: the semantic lane is opted in,
 * the worker the wiring finds is a stand-in placed where a dist entry's
 * `lib/hybrid-search/embed-worker.js` would be (process.argv[1]'s dir), and the
 * clamp program is a stand-in that records its argv and execs the rest. A query
 * makes the index fork its query worker.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getSearchV2Index, resetSearchV2IndexForTests } from '../../src/core/search/wiring.js'
import {
  QOS_CLAMP_ENV,
  _resetQosClampRequestForTest,
  _setQosClampProgramForTest,
  takeQosClampRequest,
} from '../../src/lib/background-qos.js'
import { log } from '../../src/logging/index.js'

const FIXTURE = new URL('../lib/fixtures/busy-embed-worker.cjs', import.meta.url).pathname
const saved = { semantic: process.env.WALNUT_SEARCH_V2_SEMANTIC, model: process.env.WALNUT_SEARCH_V2_EMBED_MODEL, argv1: process.argv[1] }

let dir = ''
let worker = ''
let clampLog = ''

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-embed-qos-'))
  worker = path.join(dir, 'lib', 'hybrid-search', 'embed-worker.js')
  fs.mkdirSync(path.dirname(worker), { recursive: true })
  fs.copyFileSync(FIXTURE, worker)
  process.argv[1] = path.join(dir, 'cli.js')
  process.env.WALNUT_SEARCH_V2_SEMANTIC = '1'
  delete process.env.WALNUT_SEARCH_V2_EMBED_MODEL
  clampLog = path.join(dir, 'clamp.log')
  const program = path.join(dir, 'clamp-stand-in')
  fs.writeFileSync(program, `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(clampLog)}
[[ "$1" == -c && "$2" == utility ]] || exit 64
shift 2
exec "$@"
`, { mode: 0o755 })
  _setQosClampProgramForTest(program)
})

afterAll(() => {
  _setQosClampProgramForTest(null)
  process.argv[1] = saved.argv1
  if (saved.semantic === undefined) delete process.env.WALNUT_SEARCH_V2_SEMANTIC
  else process.env.WALNUT_SEARCH_V2_SEMANTIC = saved.semantic
  if (saved.model === undefined) delete process.env.WALNUT_SEARCH_V2_EMBED_MODEL
  else process.env.WALNUT_SEARCH_V2_EMBED_MODEL = saved.model
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  for (const level of ['info', 'warn', 'debug'] as const) vi.spyOn(log.memory, level).mockImplementation(() => {})
  fs.rmSync(clampLog, { force: true })
  _resetQosClampRequestForTest()
  resetSearchV2IndexForTests()
})

afterEach(async () => {
  resetSearchV2IndexForTests()
  _resetQosClampRequestForTest()
  vi.restoreAllMocks()
})

/** Ask one semantic query, which starts the query worker; returns the lane's state. */
async function query(): Promise<string[]> {
  const index = getSearchV2Index()
  index.upsert({ kind: 'task', ref: 't-qos-1', title: 'Rotate the marina keys', updatedAt: Date.now() })
  const states: string[] = []
  await index.searchSemantic('rotate keys', { semanticDeadlineMs: 10_000, onSemantic: (s) => states.push(s) })
  return states
}

describe('embedding workers and the QoS clamp', () => {
  it('are forked behind the clamp when the server asked for it', async () => {
    expect(takeQosClampRequest({ [QOS_CLAMP_ENV]: '1' })).toBe(true)
    const states = await query()
    expect(states).not.toEqual(['disabled'])
    expect(fs.readFileSync(clampLog, 'utf8').split('\n').filter(Boolean)[0]).toBe(`-c utility ${process.execPath} ${worker}`)
  }, 20_000)

  it('are forked plainly when it did not (a terminal or the Mac app)', async () => {
    expect(takeQosClampRequest({})).toBe(false)
    const states = await query()
    // A worker ran (the lane is not disabled), and not through the clamp.
    expect(states).not.toEqual(['disabled'])
    expect(fs.existsSync(clampLog)).toBe(false)
  }, 20_000)
})
