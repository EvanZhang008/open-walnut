/**
 * A light subagent's end reaches its parent session only through the one gate
 * (parentHearsNothing in src/core/subagents/registry.ts): never into a stopped session or one
 * whose task is COMPLETE, and only into the session still live when the row is stored
 * (liveOnly). A stop is recorded as a stop on every path: end() alone writes the error code.
 * A new way to put a line into a session, or a new writer of the code, fails here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const DIR = 'src/core/subagents'
const files = fs.readdirSync(path.join(ROOT, DIR)).filter((f) => f.endsWith('.ts')).map((f) => ({
  file: `${DIR}/${f}`,
  code: fs.readFileSync(path.join(ROOT, DIR, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n'),
}))

/** The text of each call of `name(`, parentheses balanced. */
function callsOf(code: string, name: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(new RegExp(`(?<![\\w.])${name}\\(`, 'g'))) {
    let depth = 0
    for (let i = m.index! + m[0].length - 1; i < code.length; i++) {
      if (code[i] === '(') depth++
      else if (code[i] === ')' && --depth === 0) { out.push(code.slice(m.index!, i + 1)); break }
    }
  }
  return out
}

const SENDS = ['deliverToSession', 'sendMessageToSession', 'enqueueMessage', 'deliverNotice', 'injectMidTurn']

describe('a light subagent tells its parent only through the gate', () => {
  it('every line it puts into a session is the one gated, live-only end notice', () => {
    const sites: string[] = []
    for (const { file, code } of files) {
      for (const name of SENDS) for (const call of callsOf(code, name)) sites.push(`${file}: ${name}${/liveOnly\s*:/.test(call) ? ' liveOnly' : ''}`)
    }
    expect(sites).toEqual(['src/core/subagents/registry.ts: deliverToSession liveOnly'])
    const reg = files.find((f) => f.file.endsWith('/registry.ts'))!.code
    const tell = reg.slice(reg.indexOf('async function tellParent('))
    expect(tell.indexOf('parentHearsNothing(')).toBeGreaterThan(0)
    expect(tell.indexOf('parentHearsNothing(')).toBeLessThan(tell.indexOf('deliverToSession('))
  })

  it('the gate refuses a stopped or archived session and a COMPLETE task', () => {
    const reg = files.find((f) => f.file.endsWith('/registry.ts'))!.code
    const gate = reg.slice(reg.indexOf('export async function parentHearsNothing('), reg.indexOf('async function tellParent('))
    expect(gate).toMatch(/isLiveSessionStatus\(/)
    expect(gate).toMatch(/archived/)
    expect(gate).toMatch(/phase === 'COMPLETE'/)
  })

  it('only end() writes a run\'s error code, and a stop there is always code stopped', () => {
    const writers = files.flatMap(({ file, code }) => [...code.matchAll(/\brun\.errorCode\s*=(?!=)/g)].map(() => file))
    expect(writers).toEqual(['src/core/subagents/registry.ts'])
    const reg = files.find((f) => f.file.endsWith('/registry.ts'))!.code
    const end = reg.slice(reg.indexOf('function end('), reg.indexOf('\n}\n', reg.indexOf('function end(')))
    expect(end).toMatch(/run\.errorCode = status === 'stopped' \? 'stopped'/)
  })
})
