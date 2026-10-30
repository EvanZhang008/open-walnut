/**
 * A workflow download from the network retries.
 *
 * GitHub's API and other hosts drop a transfer now and then (2026-10-30: the leak
 * audit failed on `curl: (92) HTTP/2 stream 1 was not closed cleanly: CANCEL`
 * fetching a run's logs, and the same API answered 502 to a jobs read minutes
 * before), and one dropped transfer failed the whole job. Every `curl` in a
 * workflow that reaches past this runner carries `--retry` with
 * `--retry-all-errors` (a cut HTTP/2 stream is not a transient error to curl
 * without it). A readiness poll (`if curl …` in a loop) retries by itself, and
 * a request to 127.0.0.1 never crosses a network.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const WORKFLOWS = path.resolve(import.meta.dirname, '../../.github/workflows')

function curlLines(): { where: string; line: string }[] {
  const out: { where: string; line: string }[] = []
  for (const name of fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    fs.readFileSync(path.join(WORKFLOWS, name), 'utf8').split('\n').forEach((line, i) => {
      if (/(^|[\s;|&(])curl\s/.test(line) && !/^\s*#/.test(line)) out.push({ where: `${name}:${i + 1}`, line: line.trim() })
    })
  }
  return out
}

describe('workflow downloads retry', () => {
  it('finds the workflow curls', () => {
    expect(curlLines().length).toBeGreaterThan(4)
  })

  it('every curl past this runner retries every error, except a readiness poll', () => {
    const missing = curlLines()
      .filter(({ line }) => !/^if\s+curl\b/.test(line))
      .filter(({ line }) => !/https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(line))
      .filter(({ line }) => !(/--retry\s+\d/.test(line) && /--retry-all-errors/.test(line)))
      .map(({ where, line }) => `${where}: ${line}`)
    expect(missing, 'add --retry N --retry-all-errors to these').toEqual([])
  })
})
