/**
 * A bun cross-compile fetches its target's runtime on first use, the only network step of
 * the build. 2026-11-23 (Nightly extra tests run 45131663248): "Failed to download
 * 'bun-linux-x64-v1.4.4': DNSResolveFailed" on a GitHub runner ended the build, so every
 * compile now runs again when, and only when, that download failed:
 * scripts/lib/bun-compile.sh (bun_compile) for shell, scripts/lib/bun-compile-retry.mjs
 * (buildWithRuntimeRetry) for Bun.build. This file checks both helpers with stand-in buns,
 * and fails when a new compile in scripts/, .github/ or package.json skips them.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { guardedPath } from '../setup/exec-guard-core.js'
import { RUNTIME_DOWNLOAD_FAILED, buildWithRuntimeRetry } from '../../scripts/lib/bun-compile-retry.mjs'

const REPO = path.join(import.meta.dirname, '..', '..')
const SHELL_HELPER = path.join(REPO, 'scripts', 'lib', 'bun-compile.sh')
// bun 1.4.4's own words: the CLI on stderr, Bun.build in result.logs (seen with no network).
const CLI_WORDS = "Failed to download 'bun-linux-x64-v1.4.4': DNSResolveFailed"
const API_WORDS = "BuildMessage: Failed to download 'bun-linux-x64-musl-baseline-v1.4.4': ConnectionRefused"

function files(dir: string, keep: (f: string) => boolean): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...files(rel, keep)) } else if (keep(rel)) out.push(rel)
  }
  return out
}

/** The text of each `Bun.build(...)` call in `src`, with what stands right before it. */
function bunBuildCalls(src: string): { before: string; call: string }[] {
  const calls: { before: string; call: string }[] = []
  for (let i = src.indexOf('Bun.build('); i !== -1; i = src.indexOf('Bun.build(', i + 1)) {
    let depth = 0
    let j = i + 'Bun.build'.length
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++
      else if (src[j] === ')' && --depth === 0) break
    }
    calls.push({ before: src.slice(Math.max(0, i - 40), i), call: src.slice(i, j + 1) })
  }
  return calls
}

describe('every bun compile retries a failed runtime download', () => {
  it('no shell compile in scripts/, .github/ or package.json runs bun directly', () => {
    const shellish = [...files('scripts', (f) => /\.(sh|bash|mjs|js|ts|ya?ml)$/.test(f)), ...files('.github', (f) => /\.ya?ml$/.test(f)), 'package.json']
      .filter((f) => f !== 'scripts/lib/bun-compile.sh')
    // `bun`, `"$BUN"`, `"$BUN_BIN"`, `${bun}`: any bun, its `--compile` on the same line or a
    // continued one; comment lines are prose.
    const direct = /(?:\bbun|\$\{?\w+\}?)"?\s+build\b[^\n]*--compile/i
    const code = (f: string) => fs.readFileSync(path.join(REPO, f), 'utf8').replace(/\\\n\s*/g, ' ')
      .split('\n').filter((l) => !/^\s*(#|\/\/|\*)/.test(l)).join('\n')
    const offenders = shellish.filter((f) => direct.test(code(f)))
    expect(offenders, 'run it as bun_compile <args> (scripts/lib/bun-compile.sh)').toEqual([])
    expect(fs.readFileSync(path.join(REPO, 'scripts/build-daemon.sh'), 'utf8')).toMatch(/bun_compile --target=bun-linux-x64 /)
  })

  it('every Bun.build with compile in scripts/ goes through buildWithRuntimeRetry', () => {
    const found: string[] = []
    const offenders: string[] = []
    for (const f of files('scripts', (x) => /\.(mjs|js|ts)$/.test(x))) {
      const src = fs.readFileSync(path.join(REPO, f), 'utf8')
      for (const { before, call } of bunBuildCalls(src)) {
        if (!/\bcompile\s*:/.test(call)) continue
        found.push(f)
        if (!/buildWithRuntimeRetry\(\(\) => $/.test(before)) offenders.push(`${f}: ${call.slice(0, 80)}`)
      }
    }
    // build-binary.mjs's compile() and runtimeSize(); its codeReport() bundles without compiling.
    expect(found.filter((f) => f === 'scripts/build-binary.mjs').length).toBe(2)
    expect(offenders).toEqual([])
  })

  it('the shell and the JS helper match the same words, which are bun\'s own', () => {
    expect(RUNTIME_DOWNLOAD_FAILED.test(CLI_WORDS)).toBe(true)
    expect(RUNTIME_DOWNLOAD_FAILED.test(API_WORDS)).toBe(true)
    const literal = /grep -q "([^"]+)"/.exec(fs.readFileSync(SHELL_HELPER, 'utf8'))?.[1]
    expect(literal).toBe("Failed to download 'bun-")
    expect(CLI_WORDS.includes(literal!)).toBe(true)
    expect(RUNTIME_DOWNLOAD_FAILED.test('error: Could not resolve: "./missing.ts"')).toBe(false)
  })
})

describe('buildWithRuntimeRetry', () => {
  const failed = (msg: string) => ({ success: false, logs: [msg] })
  const run = async (answers: { success: boolean; logs: string[] }[], tries = 3) => {
    let calls = 0
    const lines: string[] = []
    const result = await buildWithRuntimeRetry(async () => answers[Math.min(calls++, answers.length - 1)], { tries, delayMs: 0, log: (l: string) => lines.push(l) })
    return { result, calls, lines }
  }

  it('runs again after a failed runtime download and returns the build that worked', async () => {
    const r = await run([failed(API_WORDS), { success: true, logs: [] }])
    expect(r.result.success).toBe(true)
    expect(r.calls).toBe(2)
    expect(r.lines[0]).toMatch(/try 1 of 3 could not download the bun runtime/)
  })

  it('returns any other failure at once', async () => {
    const r = await run([failed('BuildMessage: Could not resolve: "./missing.ts"'), { success: true, logs: [] }])
    expect(r.result.success).toBe(false)
    expect(r.calls).toBe(1)
  })

  it('gives up after its tries and returns the last failure', async () => {
    const r = await run([failed(API_WORDS)], 3)
    expect(r.result.success).toBe(false)
    expect(r.calls).toBe(3)
  })
})

describe('bun_compile', () => {
  /** A stand-in bun that answers from a list of exit codes and messages, one per call. */
  function runShell(answers: [number, string][], tries: number | string = 3) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bun-compile-'))
    const count = path.join(dir, 'count')
    fs.writeFileSync(count, '0')
    const cases = answers.map(([code, msg], i) => `  ${i}) echo ${JSON.stringify(msg)} >&2; exit ${code} ;;`).join('\n')
    const last = answers[answers.length - 1]
    fs.writeFileSync(path.join(dir, 'bun'), `#!/bin/sh\nn=$(cat ${JSON.stringify(count)}); echo $((n + 1)) > ${JSON.stringify(count)}\necho "args: $*"\ncase $n in\n${cases}\n  *) echo ${JSON.stringify(last[1])} >&2; exit ${last[0]} ;;\nesac\n`, { mode: 0o755 })
    const r = spawnSync('/bin/sh', ['-c', `. ${JSON.stringify(SHELL_HELPER)}; BUN=${JSON.stringify(path.join(dir, 'bun'))}; bun_compile --target=bun-linux-x64 --outfile out a.ts`], {
      encoding: 'utf8',
      env: { PATH: guardedPath([], '/usr/bin:/bin'), BUN_COMPILE_RETRY_SECS: '0', BUN_COMPILE_TRIES: String(tries) },
    })
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, calls: Number(fs.readFileSync(count, 'utf8')) }
  }

  it('runs again after a failed runtime download and passes its arguments each time', () => {
    const r = runShell([[1, CLI_WORDS], [0, 'compiled']])
    expect(r.code).toBe(0)
    expect(r.calls).toBe(2)
    expect(r.stdout).toContain('args: build --compile --target=bun-linux-x64 --outfile out a.ts')
    expect(r.stderr).toMatch(/try 1 of 3 could not download the bun runtime/)
  })

  it('fails at once on any other error, showing it', () => {
    const r = runShell([[7, 'error: Could not resolve: "./missing.ts"'], [0, 'compiled']])
    expect(r.code).toBe(7)
    expect(r.calls).toBe(1)
    expect(r.stderr).toContain('Could not resolve')
  })

  it('gives up after its tries, saying so', () => {
    const r = runShell([[1, CLI_WORDS]], 3)
    expect(r.code).toBe(1)
    expect(r.calls).toBe(3)
    expect(r.stderr).toMatch(/gave up after 3 tries/)
  })

  it('takes three tries when BUN_COMPILE_TRIES is not a number', () => {
    expect(runShell([[1, CLI_WORDS]], 'many').calls).toBe(3)
  })
})
