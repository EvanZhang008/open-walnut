/**
 * The compiled Walnut file (scripts/build-binary.mjs), rehearsed the way a person
 * meets it on any machine: nothing installed but the file itself. The CI matrix
 * runs this inside old and new Linux images and on macOS
 * (.github/workflows/binary-matrix.yml), with the file itself as the runtime
 * (`BUN_BE_BUN=1 walnut scripts/release-rehearsal/run.mjs --binary walnut`), so a
 * machine needs no Node and no bun for the rehearsal either.
 *
 *   binary          `walnut --version` names the version, `walnut __selftest`
 *                   passes (the file's own parts, src/binary/selftest.ts), and
 *                   the file runs a script as bun (what plugin installs use).
 *   binary-serve    with no node, npm or bun on PATH: health with `claude` found,
 *                   the SPA, /api/v1/status.
 *   binary-task     a task is created and listed (SQLite inside the file).
 *   binary-session  a session answers its first message, then a second one
 *                   sent to the live CLI.
 *   binary-restart  after the server restarts, the task and the history are
 *                   there and a third message is answered.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { systemPathWithoutNode } from './runtime.mjs'
import { IsolatedWalnut } from './walnut.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const nonce = () => crypto.randomBytes(4).toString('hex')
const ask = (label, mark) => ({ text: `snapshot-clean-turn:answered ${label} ${mark}`, answer: `answered ${label} ${mark}` })

/** Run every binary scenario; returns how many were expected. */
export async function rehearseBinary({ work, binary, scenario, walnuts }) {
  const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version
  // No node, npm or bun on the PATH the server sees: the file must need none.
  const bareDir = systemPathWithoutNode(path.join(work, 'system-bin'))
  for (const name of ['bun', 'bunx']) fs.rmSync(path.join(bareDir, name), { force: true })
  const w = new IsolatedWalnut({ work, name: 'binary', bin: binary })
  w.env.PATH = [w.binDir, path.join(w.home, '.local/bin'), bareDir].join(path.delimiter)
  walnuts.push(w)
  const marks = [nonce(), nonce(), nonce()]
  let taskId = null
  let title = null
  let sessionId = null

  const ok = await scenario('binary', async () => {
    const printed = w.version()
    if (printed.split(/\s/)[0] !== version) throw new Error(`--version says "${printed}", expected ${version}`)
    const asBun = execFileSync(binary, ['-e', 'console.log(typeof Bun.version)'], {
      env: { ...w.env, BUN_BE_BUN: '1' }, encoding: 'utf8', timeout: 60_000,
    }).trim()
    if (asBun !== 'string') throw new Error(`BUN_BE_BUN=1 ${path.basename(binary)} -e printed "${asBun}"`)
    const selftest = spawnSync(binary, ['__selftest'], { env: w.env, encoding: 'utf8', timeout: 120_000 })
    const checks = selftest.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))
    if (selftest.status !== 0) {
      const failed = checks.filter((c) => !c.ok).map((c) => `${c.check}: ${c.error ?? c.detail}`).join('; ')
      throw new Error(`__selftest exited ${selftest.status}: ${failed || selftest.stderr.slice(-400)}`)
    }
    return `${printed}; selftest ${checks.filter((c) => c.ok).length}/${checks.length}`
  })
  const served = ok && await scenario('binary-serve', async () => {
    const health = await w.start()
    if (health.claudeCliAvailable !== true) throw new Error(`health reports claudeCliAvailable=${health.claudeCliAvailable} with claude on PATH`)
    const spa = await fetch(`${w.base}/`)
    const html = await spa.text()
    if (spa.status !== 200 || !/<div id="root"|<html/i.test(html)) throw new Error(`GET / answered ${spa.status}`)
    const status = await w.api('GET', '/api/v1/status')
    if (status.json?.version !== version) throw new Error(`/api/v1/status says ${status.json?.version ?? status.text.slice(0, 200)}`)
    return `health ok, SPA ${html.length} bytes`
  })
  const tasked = served && await scenario('binary-task', async () => {
    title = `binary task ${nonce()} caf\u00e9`
    const made = await w.api('POST', '/api/v1/tasks', { title })
    taskId = made.json?.task?.id
    if (made.status !== 201 || !taskId) throw new Error(`POST /api/v1/tasks answered ${made.status} ${made.text.slice(0, 300)}`)
    const list = await w.api('GET', '/api/v1/tasks')
    if (!(list.json?.tasks ?? []).some((t) => t.id === taskId && t.title === title)) throw new Error(`task ${taskId} is not listed (${list.status} ${list.text.slice(0, 200)})`)
    return `task ${taskId}`
  })
  const talked = tasked && await scenario('binary-session', async () => {
    const one = ask('one', marks[0])
    const res = await w.api('POST', '/api/v1/sessions', { cwd: w.project, message: one.text })
    if (res.status !== 201 || !res.json?.sessionId) throw new Error(`POST /api/v1/sessions answered ${res.status} ${res.text.slice(0, 300)}`)
    sessionId = res.json.sessionId
    await w.waitForAnswer(sessionId, one.answer)
    const two = ask('two', marks[1])
    const send = await w.api('POST', '/api/v1/messages', { to: sessionId, text: two.text })
    if (send.status !== 202) throw new Error(`POST /api/v1/messages answered ${send.status} ${send.text.slice(0, 300)}`)
    await w.waitForAnswer(sessionId, two.answer)
    return `session ${sessionId} answered two messages`
  })
  if (talked) {
    await scenario('binary-restart', async () => {
      await w.stop()
      await w.start()
      const list = await w.api('GET', '/api/v1/tasks')
      if (!(list.json?.tasks ?? []).some((t) => t.id === taskId && t.title === title)) throw new Error(`task ${taskId} is gone after a restart`)
      const messages = await w.waitForAnswer(sessionId, ask('two', marks[1]).answer, 60_000)
      if (!messages.some((m) => m.role === 'assistant' && m.text?.includes(ask('one', marks[0]).answer))) {
        throw new Error('the first turn is gone from the history after a restart')
      }
      const three = ask('three', marks[2])
      const send = await w.api('POST', '/api/v1/messages', { to: sessionId, text: three.text })
      if (send.status !== 202) throw new Error(`POST /api/v1/messages answered ${send.status} ${send.text.slice(0, 300)}`)
      await w.waitForAnswer(sessionId, three.answer)
      return 'task and history kept, third message answered'
    })
  }
  await w.shutdown()
  return 5
}
