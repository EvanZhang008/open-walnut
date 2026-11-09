/**
 * Our own share of the load (scripts/lib/own-load.sh and its twin in tests/setup/cpu-idle.ts).
 *
 * 2026-11-08: lane B and the iOS fleet's Mac half stayed shut for hours at a load of 40 to 80 while
 * a third of the CPU stood idle; a video call app and security agents held most of the runnable
 * threads. Over the load line a gate now counts only the share our own processes hold.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { capacityVerdict, OWN_LOAD_CEILING_PER_CORE, OWN_LOAD_RE, ownLoadPerCore, parseRunnableShare } from '../setup/cpu-idle'

const ROOT = path.resolve(__dirname, '../..')
const LIB = path.join(ROOT, 'scripts/lib/own-load.sh')

// A tree with an agent CLI and its shell's child, a bun test runner, a simulator's process, and
// three processes that are not ours (a call app, an endpoint agent, launchd).
const TREE = [
  '    1     0 /sbin/launchd',
  '  500     1 /Applications/CallApp.app/Contents/MacOS/callapp',
  '  600     1 /Users/x/.local/bin/claude',
  '  601   600 /bin/zsh',
  '  602   601 /usr/bin/python3',
  '  700     1 /Library/Application Support/Endpoint/agent',
  '  800     1 /Users/x/.bun/bin/bun',
  '  900     1 /Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/launchd_sim',
  '  901   900 /Library/Developer/CoreSimulator/Volumes/iOS/RuntimeRoot/usr/sbin/cfprefsd',
].join('\n')
// One `ps -axM` sample: runnable threads 500 x3, 602 x1, 700 x1, 800 x1 (thread line), 901 x2.
const AXM = [
  'USER               PID   TT   %CPU STAT PRI     STIME     UTIME COMMAND',
  'x                  500   ??    0.3 R    31T   0:00.10   0:00.05 /Applications/CallApp.app/Contents/MacOS/callapp',
  '                   500         0.0 R    31T   0:00.01   0:00.01',
  '                   500         0.0 R    31T   0:00.01   0:00.01',
  '                   500         0.0 S    31T   0:00.01   0:00.01',
  'x                  602 s001    9.0 R    31T   0:01.00   0:02.00 /usr/bin/python3',
  'root               700   ??    1.0 R    4T    0:00.00   0:00.00 /Library/Application Support/Endpoint/agent',
  'x                  800   ??    0.0 S    4T    0:00.00   0:00.00 /Users/x/.bun/bin/bun',
  '                   800         5.0 R    4T    0:00.00   0:00.00',
  'x                  901   ??    2.0 R    4T    0:00.00   0:00.00 /Library/Developer/CoreSimulator/Volumes/iOS/RuntimeRoot/usr/sbin/cfprefsd',
  '                   901         1.0 R    4T    0:00.00   0:00.00',
].join('\n')

function shell(script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-load-'))
  fs.writeFileSync(path.join(dir, 'full'), TREE + '\n')
  fs.writeFileSync(path.join(dir, 'axm'), AXM + '\n')
  try {
    const r = spawnSync('/bin/sh', ['-c', `. '${LIB}'; ${script}`], {
      encoding: 'utf8',
      env: { ...process.env, OWN_LOAD_PS_FULL: path.join(dir, 'full'), OWN_LOAD_PS_AXM: path.join(dir, 'axm'), OWN_LOAD_SAMPLES: '2' },
    })
    expect(r.status, r.stderr).toBe(0)
    return r.stdout.trim()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('our own share of the load', () => {
  it('counts an agent CLI and what it starts, bun and a simulator as ours, the rest as not', () => {
    expect(shell('own_load_share')).toBe('4.0 4.0')
    expect(parseRunnableShare(TREE, [AXM, AXM])).toEqual({ ours: 4, others: 4 })
  })

  it('a child that shows only in the tree read after the samples is still ours', () => {
    const before = TREE.split('\n').filter((l) => !l.includes(' 602 ')).join('\n')
    expect(parseRunnableShare(before, [AXM])).toEqual({ ours: 3, others: 5 })
    expect(parseRunnableShare(`${before}\n${TREE}`, [AXM])).toEqual({ ours: 4, others: 4 })
  })

  it('over the line the load is our share of it; under it, the load itself', () => {
    expect(shell('own_load 60 14 2; echo "$OWN_LOAD|$OWN_LOAD_NOTE"')).toBe(
      "30.00|the Mac's whole load is 60; our processes hold 4.0 of 8.0 runnable threads, other processes 4.0",
    )
    expect(shell('own_load 20 14 2; echo "$OWN_LOAD|$OWN_LOAD_NOTE"')).toBe('20|')
    const share = () => ({ ours: 4, others: 4 })
    expect(ownLoadPerCore(60 / 14, 2, share)).toEqual({ perCore: 30 / 14, rawPerCore: 60 / 14 })
    expect(ownLoadPerCore(20 / 14, 2, share)).toEqual({ perCore: 20 / 14 })
  })

  it('a share that cannot be read, or with no other thread, leaves the whole load', () => {
    expect(ownLoadPerCore(4, 2, () => null)).toEqual({ perCore: 4 })
    expect(ownLoadPerCore(4, 2, () => ({ ours: 9, others: 0 }))).toEqual({ perCore: 4 })
    expect(parseRunnableShare(TREE, [])).toBeNull()
    const r = spawnSync('/bin/sh', ['-c', `. '${LIB}'; OWN_LOAD_PS_AXM= ; uname() { echo Linux; }; own_load 60 14 2; echo "$OWN_LOAD"`], { encoding: 'utf8' })
    expect(r.stdout.trim()).toBe('60')
  })

  it('our own work over the line still holds a run, and the wait says whose load it is', () => {
    const v = capacityVerdict({ idlePct: 40, loadPerCore: 40 / 14, rawLoadPerCore: 80 / 14, cores: 14 }, { minIdlePct: 20, maxLoadPerCore: 2 })
    expect(v).toEqual({ ok: false, why: 'load 40 (our share of the whole load 80) on 14 cores is over 2 per core' })
    const ok = capacityVerdict({ idlePct: 40, loadPerCore: 14 / 14, rawLoadPerCore: 60 / 14, cores: 14 }, { minIdlePct: 20, maxLoadPerCore: 2 })
    expect(ok.ok).toBe(true)
    // What the others take of the CPU still counts.
    expect(capacityVerdict({ idlePct: 10, loadPerCore: 1, rawLoadPerCore: 4, cores: 14 }, { minIdlePct: 20, maxLoadPerCore: 2 }).ok).toBe(false)
  })

  it('over the ceiling the whole load counts again, whoever holds the threads (2026-11-09: 371 on 14 cores)', () => {
    expect(shell('own_load 371 14 2; echo "$OWN_LOAD|$OWN_LOAD_NOTE"')).toBe(
      "371|the Mac's whole load is 371, over 6 per CPU, where the whole load counts whoever holds it",
    )
    // The 2026-11-08 case stays a share: 80 on 14 CPUs is under 6 per CPU.
    expect(shell('own_load 80 14 2; echo "$OWN_LOAD"')).toBe('40.00')
    expect(shell('OWN_LOAD_CEILING=3; own_load 80 14 2; echo "$OWN_LOAD"')).toBe('80')
    const share = () => ({ ours: 1, others: 9 })
    expect(ownLoadPerCore(371 / 14, 2, share)).toEqual({ perCore: 371 / 14 })
    expect(ownLoadPerCore(80 / 14, 2, share)).toEqual({ perCore: 8 / 14, rawPerCore: 80 / 14 })
    expect(ownLoadPerCore(80 / 14, 2, share, 3)).toEqual({ perCore: 80 / 14 })
  })

  it('the shell and TypeScript twins use the same ceiling', () => {
    const sh = /^OWN_LOAD_CEILING=\$\{OWN_LOAD_CEILING:-([0-9.]+)\}$/m.exec(fs.readFileSync(LIB, 'utf8'))?.[1]
    expect(Number(sh)).toBe(OWN_LOAD_CEILING_PER_CORE)
  })

  it('the shell and TypeScript twins use the same pattern', () => {
    const sh = /^OWN_LOAD_RE='(.*)'$/m.exec(fs.readFileSync(LIB, 'utf8'))?.[1]
    expect(sh).toBeTruthy()
    expect(OWN_LOAD_RE.source.replace(/\\\//g, '/')).toBe(sh)
  })
})
