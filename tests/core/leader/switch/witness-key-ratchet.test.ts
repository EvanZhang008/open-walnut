/**
 * A witness's own key (core/leader/switch/witness-keys.ts) lets its holder speak for the leader
 * to that witness, so it may be in exactly these places: config.yaml (leader data, travels only
 * with the standby copy), the witness's key file beside its record, a setup body over an
 * authenticated link, and the HMAC it keys. Contract under test, in the style of the push token
 * and config secret checks:
 *   - no log line, at any level, of the door, the caller, a setup or the config holds a key
 *     (every entry is caught where all of them pass, the file transport's writeLogEntry);
 *   - no answer of the door and no error message holds one;
 *   - every client view of the config masks it with bullets only (not even its last characters),
 *     and a view sent back puts the stored key back;
 *   - a host's config copy never carries one (leader_switch is not on the copy's allowlist);
 *   - the source that reads a key is a closed list of files, and none of them hands a key to a
 *     log call, a thrown error or a console line.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../../helpers/mock-constants.js'

const captured = vi.hoisted(() => {
  process.env.WALNUT_LOG_LEVEL = 'trace'
  return [] as Array<Record<string, unknown>>
})
vi.mock('../../../../src/constants.js', () => createMockConstants('witness-key-ratchet'))
vi.mock('../../../../src/logging/logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/logging/logger.js')>()),
  writeLogEntry: (entry: Record<string, unknown>) => { captured.push(entry) },
}))

const ROOT = path.resolve(import.meta.dirname, '../../../..')
const WALNUT = 'walnut-key-ratchet'
const LIST = ['w1', 'w2', 'w3']

let base = ''
let server: http.Server
let url = ''
let key = ''

beforeAll(async () => {
  const { proofSecret } = await import('../../../../src/utils/hmac-proof.js')
  key = proofSecret()
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-key-ratchet-'))
  const { setUpMachineWitness } = await import('../../../../src/core/leader/switch/witness-route.js')
  const { log } = await import('../../../../src/logging/index.js')
  const { blankEvidence } = await import('../../../helpers/witness-machines.js')
  expect((await setUpMachineWitness(base, { v: 1, walnutId: WALNUT, witness: 'w1', list: LIST, evidence: blankEvidence(LIST, 'w1'), key }, (level, msg, data) => log.web[level](msg, data))).status).toBe(200)
  const { createWitnessDoorRouter } = await import('../../../../src/web/routes/witness-door.js')
  const { WITNESS_DOOR_PATH } = await import('../../../../src/core/leader/switch/witness-wire.js')
  const app = express()
  app.use(WITNESS_DOOR_PATH, createWitnessDoorRouter({ root: base }))
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}${WITNESS_DOOR_PATH}`
})
afterAll(async () => {
  await new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()) })
  fs.rmSync(base, { recursive: true, force: true })
})

describe('a witness key goes nowhere but where it belongs', () => {
  it('no log line, door answer or error message holds it, across every refusal and a good call', async () => {
    const { directWitnessCall } = await import('../../../../src/core/leader/switch/witness-direct.js')
    const { WITNESS_REQUEST_PATH } = await import('../../../../src/core/leader/switch/witness-wire.js')
    const { proofSecret } = await import('../../../../src/utils/hmac-proof.js')
    const answers: unknown[] = []
    const post = (u: string, body: unknown, done: (r: { status: number; json: unknown } | null) => void) => {
      void fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(async (res) => { const json = await res.json().catch(() => null); answers.push(json); done({ status: res.status, json }) }, () => done(null))
    }
    const call = (k: string, walnutId = WALNUT) => new Promise((resolve) => {
      directWitnessCall({ post })({ id: 'w1', url, key: k }, WITNESS_REQUEST_PATH, { v: 1, walnutId, witness: 'w1', request: { type: 'read' } }, resolve)
    })
    expect((await call(key) as { status: number }).status).toBe(200)
    expect((await call(proofSecret()) as { status: number }).status).toBe(403)
    expect((await call(key, 'another-walnut') as { status: number }).status).toBe(404)
    // Malformed bodies, a replayed nonce.
    for (const body of [{}, { v: 1, nonce: 'x' }, { v: 1, nonce: proofSecret(), proof: proofSecret(), call: '{' }]) {
      const r = await fetch(`${url}/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      answers.push(await r.json().catch(() => null))
    }
    // Setups: a second key refused, a bad list.
    const { setUpMachineWitness } = await import('../../../../src/core/leader/switch/witness-route.js')
    const { log } = await import('../../../../src/logging/index.js')
    const { blankEvidence } = await import('../../../helpers/witness-machines.js')
    const evidence = blankEvidence(LIST, 'w1')
    answers.push((await setUpMachineWitness(base, { v: 1, walnutId: WALNUT, witness: 'w1', list: LIST, evidence, key: proofSecret() }, (level, msg, data) => log.web[level](msg, data))).body)
    answers.push((await setUpMachineWitness(base, { v: 1, walnutId: WALNUT, witness: 'w1', list: LIST, evidence, key }, (level, msg, data) => log.web[level](msg, data))).body)
    // Refused beside a record: the evidence names one.
    answers.push((await setUpMachineWitness(base, { v: 1, walnutId: WALNUT, witness: 'w1', list: LIST, evidence: [{ witness: 'w2', seen: 'record' }, { witness: 'w3', seen: 'unreached' }], key }, (level, msg, data) => log.web[level](msg, data))).body)
    // Config problems name the witness, never its key.
    const { parseSwitchSettings } = await import('../../../../src/core/leader/switch/settings.js')
    const machines = [{ id: 'a', home: '/a', standby_dir: '/as', port: 1 }, { id: 'b', home: '/b', standby_dir: '/bs', port: 2 }]
    const problems = [
      parseSwitchSettings({ witnesses: [{ id: 'w1', host: 'h', key: `${key}x` }, { id: 'w2', host: 'h2' }, { id: 'w3', host: 'h3' }], machines }).problem,
      parseSwitchSettings({ witnesses: [{ id: 'w1', url: 'http://far.example', key }, { id: 'w2', host: 'h2' }, { id: 'w3', host: 'h3' }], machines }).problem,
    ]
    // The companion setup's errors (no lane, another origin): the key is never sent and never quoted.
    const { setUpCompanionWitness } = await import('../../../../src/core/leader/switch/witness-direct.js')
    const sent: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => { sent.push(`${String(input)} ${String(init?.body ?? '')}`); return realFetch(input as string, init as RequestInit) }) as typeof fetch
    try {
      problems.push((await setUpCompanionWitness({ id: 'w1', url, key }, LIST, WALNUT, [], async () => null) as { error: string }).error)
      problems.push((await setUpCompanionWitness({ id: 'w1', url, key }, LIST, WALNUT, [], async () => ({ url: 'https://another.example/bridge', token: 't' })) as { error: string }).error)
    } finally {
      globalThis.fetch = realFetch
    }
    expect(sent, 'a setup to another origin sends nothing').toEqual([])

    expect(captured.length, 'log entries were caught').toBeGreaterThan(0)
    const all = JSON.stringify({ captured, answers, problems })
    expect(all).not.toContain(key)
  })

  it('every client view of the config masks the key with bullets only, and a view sent back keeps the stored key', async () => {
    const { maskForMacClients, redactConfig } = await import('../../../../src/core/config-redact.js')
    const { restoreMaskedSecrets } = await import('../../../../src/core/config-secret-shape.js')
    const stored = { leader_switch: { witnesses: [{ id: 'w1', machine: 'm1', host: 'h1', key }, { id: 'w2', url: 'https://box/leader-witness', key: key.split('').reverse().join('') }, { id: 'w3', host: 'h3' }] } }
    for (const view of [maskForMacClients(stored), redactConfig(stored) as typeof stored]) {
      const text = JSON.stringify(view)
      expect(text).not.toContain(key)
      expect(text).not.toContain(key.slice(-4))
      expect(view.leader_switch.witnesses[0]!.key).toMatch(/^•+$/)
      expect(restoreMaskedSecrets(view, stored)).toEqual(stored)
    }
  })

  it('a host\'s config copy never carries leader_switch, keys and all', async () => {
    const { configCopyRows, CONFIG_COPY_DROPPED, CONFIG_COPY_ALLOWLIST } = await import('../../../../src/core/replication/config-allowlist.js')
    expect(Object.hasOwn(CONFIG_COPY_ALLOWLIST, 'leader_switch')).toBe(false)
    expect(CONFIG_COPY_DROPPED.leader_switch).toBeTruthy()
    const rows = configCopyRows({ version: 1, leader_switch: { witnesses: [{ id: 'w1', machine: 'm1', key }] } })
    expect(JSON.stringify(rows)).not.toContain(key)
  })

  it('the files that read a key are a closed list, and none hands one to a log, an error or the console', () => {
    /** Every file that may read a witness key, and why. */
    const READERS: Record<string, string> = {
      'src/core/leader/switch/settings.ts': 'parses leader_switch.witnesses[].key',
      'src/core/leader/switch/witness-keys.ts': 'mints the keys into config.yaml',
      'src/core/leader/switch/witness-route.ts': 'the key file beside a record, and the setup that writes it',
      'src/core/leader/switch/witness-door.ts': 'the door checks the caller\'s proof and proves its reply with it',
      'src/core/leader/switch/witness-direct.ts': 'the caller proves with it, checks the reply with it, and sends it in the companion setup',
      'src/core/leader/switch/witness-transport.ts': 'waysOf (a door needs a key) and the setup body over a link',
      'src/core/leader/switch/witness-reach.ts': 'names a door that has no key yet',
      'src/core/leader/switch/witness-wire.ts': 'the setup body carries it',
      'src/core/leader/switch/witness-setup.ts': 'sets a witness of this machine up with its key',
      'src/core/leader/switch/local-witnesses.ts': 'names the key file, to tell a directory that holds nothing',
      'src/core/leader/switch/switch-notes.ts': 'a note goes only to a witness whose key this machine holds (way b proves with it)',
      'src/commands/leader.ts': 'init mints the keys',
      'src/core/config-redact.ts': 'masks it in every client view',
      'src/web/routes/witness-door.ts': 'refuses a companion setup that carries none',
      'src/web/routes/leader-switch.ts': 'the init route sets each witness up, its key inside the setup',
    }
    const found: string[] = []
    const walk = (rel: string) => {
      const abs = path.join(ROOT, rel)
      if (fs.statSync(abs).isFile()) { if (rel.endsWith('.ts')) found.push(rel); return }
      for (const e of fs.readdirSync(abs)) walk(path.join(rel, e))
    }
    walk('src')
    const SWITCH = 'src/core/leader/switch/'
    // In the switch's own code a key is read as `<place|setup|w|x|p|raw>.key` or through the key file's helpers;
    // anywhere else, through those helpers or on a line about witnesses.
    const READS_IN_SWITCH = /\b(?:place|setup|w|x|p|raw)\.key\b|\bkeyOf\(|readWitnessKey\(|witness-key\b/
    const HELPERS = /\b(?:readWitnessKey|setUpMachineWitness|mintWitnessKeys|maskLeaderSwitchKeys|setUpCompanionWitness)\(/
    const readsKey = (f: string, text: string) => (f.startsWith(SWITCH)
      ? READS_IN_SWITCH.test(text)
      : HELPERS.test(text) || text.split('\n').some((l) => /witness/i.test(l) && /\.key\b/.test(l)))
    const readers = found.filter((f) => readsKey(f, code(fs.readFileSync(path.join(ROOT, f), 'utf8')))).sort()
    expect(readers, 'a new file reads a witness key: add it to READERS with why, and keep it out of logs').toEqual(Object.keys(READERS).sort())
    // In those files a log call, a thrown error or a console line names no key (a `keyed` flag or a keyId is fine).
    const KEY_WORD = /\b(?:key|keys)\b(?!Id|ed)/
    const SINKS = /\b(?:log\??\.\w+\??\(|log\??\(|console\.\w+\(|new Error\(|Error\(|onRefuse\??\()/
    const bad: string[] = []
    for (const f of Object.keys(READERS)) {
      for (const [i, line] of code(fs.readFileSync(path.join(ROOT, f), 'utf8')).split('\n').entries()) {
        if (SINKS.test(line) && KEY_WORD.test(line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, ''))) bad.push(`${f}:${i + 1}: ${line.trim()}`)
      }
    }
    expect(bad).toEqual([])
  })
})

/** Code only: comment lines blanked (kept as lines so numbers stay). */
function code(text: string): string {
  return text.split('\n').map((l) => (/^\s*(\*|\/\/|\/\*)/.test(l) ? '' : l)).join('\n')
}
