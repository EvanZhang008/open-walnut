/**
 * Every way a trigger check's `walnut` call can be refused as written is told to the task that wrote
 * the check (core/routines/check-call-refused.ts). The class guard, read from the sources:
 *   - every failure code a `tools call` client prints (commands/tools.ts `fail`, providers/wn-cli.ts
 *     `failCall`) is either a refusal of the call as written (CLIENT_REFUSAL_CODES, told through the
 *     check's daemon) or named here as no refusal of the script, with why: a new code fails this
 *     test until it is sorted;
 *   - a failure whose code is computed says itself whether it is one (`asWritten`), so no answer a
 *     server already judged is told twice, and none is left untold by a default;
 *   - the relay judges every tools.call in one place (capability-router.ts handleToolsCall);
 *   - no op takes the name of a check's report to its daemon.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { CHECK_CALL_REFUSED_OP, CLIENT_REFUSAL_CODES } from '../../../src/providers/check-call-report.js'
import { CHECK_FAULT_OP } from '../../../src/providers/trigger-check-core.js'
import { listOps } from '../../../src/ops/index.js'

const ROOT = path.resolve(__dirname, '../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** Codes a client prints that are no refusal of the call as written, and why. */
const NOT_REFUSALS: Record<string, string> = {
  no_daemon: 'no daemon socket on this host: the machine, not the script',
  daemon_unreachable: 'the daemon did not answer: the machine',
  hub_timeout: 'the answer was lost: the call may have run',
  empty_response: 'the server answered 200 with no body: the server\'s fault',
}

/** Each `<fn>(` call in `src` with the text of its arguments (to the matching paren). */
function callsOf(src: string, fn: string): string[] {
  const out: string[] = []
  const re = new RegExp(`(?<![\\w.])${fn}\\(`, 'g')
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1
    let i = m.index + m[0].length
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') depth--
    }
    out.push(src.slice(m.index + m[0].length, i - 1))
  }
  return out
}

const CLIENTS: Array<{ file: string; fn: string }> = [
  { file: 'src/commands/tools.ts', fn: 'fail' },
  { file: 'src/providers/wn-cli.ts', fn: 'failCall' },
]

describe('a tools call client\'s failures are sorted', () => {
  for (const { file, fn } of CLIENTS) {
    it(`${file}: every code is a refusal as written or named as none`, () => {
      const calls = callsOf(read(file), fn).filter((a) => !/^\s*$/.test(a))
      expect(calls.length).toBeGreaterThan(5)
      const unsorted: string[] = []
      for (const a of calls) {
        const literal = /^\s*'([a-z_]+)'/.exec(a)
        if (literal) {
          if (!CLIENT_REFUSAL_CODES.has(literal[1]!) && !NOT_REFUSALS[literal[1]!]) unsorted.push(literal[1]!)
        } else if (!/\basWritten:\s*(?:false|true|refusedAsWritten\()/.test(a)) {
          // A computed code: the call says whether the answer it prints refused the call as written.
          unsorted.push(`${fn}(${a.slice(0, 60)}...) without asWritten`)
        }
      }
      expect(unsorted, 'sort each into CLIENT_REFUSAL_CODES (providers/check-call-report.ts) or NOT_REFUSALS here').toEqual([])
    })
  }

  it('both clients report through the one helper', () => {
    for (const { file } of CLIENTS) expect(read(file)).toMatch(/reportRefusedCheckCall\(/)
  })
})

describe('the relay', () => {
  it('judges every tools.call in one place', () => {
    const src = read('src/core/peers/capability-router.ts')
    // answerToolsCall answers; only handleToolsCall calls it, and tells a check's refusal.
    expect(src.match(/\banswerToolsCall\(/g)).toHaveLength(2)
    expect(src).toMatch(/const out = await answerToolsCall\(/)
    expect(src).toMatch(/payload\.triggerCaller && refusedAsWrittenOutcome\(out\)/)
  })

  it('no op takes the name of a check\'s report to its daemon', () => {
    const names = new Set(listOps().map((o) => o.name))
    expect(names.has(CHECK_CALL_REFUSED_OP)).toBe(false)
    expect(names.has(CHECK_FAULT_OP)).toBe(false)
  })
})
