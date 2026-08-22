/**
 * Regression: the version stamped into a daemon deploy must describe the
 * template bytes the deploying module actually carries, never the worktree.
 *
 * 2026-08-22 incident: a long-running server (bundle built BEFORE a source
 * edit) redeployed daemon source to a remote host. resolveDaemonSourceVersion
 * hashed the live worktree, so the OLD template shipped labeled with the NEW
 * version — every later server then saw "version match" and skipped the
 * upgrade forever. The remote silently ran stale daemon code.
 *
 * The rule now: bundled run (module under dist/) → the .version sidecar
 * written by the same build; source run (tsx/vitest) → worktree hash (the
 * template IS the worktree). These tests pin the sidecar walk and the
 * source-run branch; the bundled branch is exercised by every dev:prod deploy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readSidecarDaemonVersion,
  resolveDaemonSourceVersion,
} from '../../src/providers/daemon-source.js'
import { computeExpectedDaemonVersion } from '../../src/providers/daemon-version-check.js'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-version-stamp-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('readSidecarDaemonVersion', () => {
  it('finds the sidecar next to a dist bundle (dist/cli.js layout)', () => {
    const binDir = path.join(tmp, 'dist', 'daemon-binaries')
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(path.join(binDir, 'daemon-linux-x64.version'), 'walnut-daemon-abc123def456\n')
    expect(readSidecarDaemonVersion(path.join(tmp, 'dist', 'cli.js')))
      .toBe('walnut-daemon-abc123def456')
  })

  it('walks up from a nested bundle (dist/web/server.js layout)', () => {
    const binDir = path.join(tmp, 'dist', 'daemon-binaries')
    fs.mkdirSync(binDir, { recursive: true })
    fs.mkdirSync(path.join(tmp, 'dist', 'web'), { recursive: true })
    fs.writeFileSync(path.join(binDir, 'daemon-darwin-arm64.version'), 'walnut-daemon-feedbeef0000')
    expect(readSidecarDaemonVersion(path.join(tmp, 'dist', 'web', 'server.js')))
      .toBe('walnut-daemon-feedbeef0000')
  })

  it('returns null when no sidecar exists (binaries never built)', () => {
    fs.mkdirSync(path.join(tmp, 'dist'), { recursive: true })
    expect(readSidecarDaemonVersion(path.join(tmp, 'dist', 'cli.js'))).toBeNull()
  })

  it('ignores an empty sidecar file', () => {
    const binDir = path.join(tmp, 'dist', 'daemon-binaries')
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(path.join(binDir, 'daemon-linux-x64.version'), '  \n')
    expect(readSidecarDaemonVersion(path.join(tmp, 'dist', 'cli.js'))).toBeNull()
  })
})

describe('resolveDaemonSourceVersion (source run)', () => {
  it('returns the worktree hash under vitest — the template IS the worktree', () => {
    // Running from src/ (not dist/), so the stamp must be the live source
    // hash, NOT a stale dist sidecar from an earlier build.
    expect(resolveDaemonSourceVersion()).toBe(computeExpectedDaemonVersion())
  })
})
