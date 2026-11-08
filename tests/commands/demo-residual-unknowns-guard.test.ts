// Every way the Demo residual look can end with "could not be checked", read from the source and classified: what it means
// and why it keeps the data. A new reason, verdict or kept line that is not listed here fails, so it gets decided on purpose
// (2026-11-11 review, finding F6: an idle Demo's reset kept its data on a timeout and a launchd agent's gone command).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const src = (file: string) => fs.readFileSync(path.resolve(import.meta.dirname, '../../src/commands', file), 'utf8')
const residual = src('demo-residual-processes.ts')
const union = (text: string, name: string) => {
  const m = new RegExp(`type ${name} = ([^\\n]+)`).exec(text)
  if (!m) throw new Error(`type ${name} not found`)
  return [...m[1]!.matchAll(/'(\w+)'/g)].map(x => x[1]!).sort()
}
const keys = (o: object) => Object.keys(o).sort()

/** A look that did not read the whole table: nothing about the processes is known, so the data is kept. */
const INCOMPLETE: Record<string, string> = {
  targets: 'a Demo dir could not be resolved to its real path (an error other than a missing dir)',
  paths: 'a Demo path holds bytes ps and lsof print escaped, so no row could ever match it',
  table: 'ps, ps -E or the account-wide lsof gave no table: it failed, or ran past its timeout',
  reread: 'the re-read of the pids that changed during the look gave no table',
  proc: 'Linux: /proc could not be listed, or did not list this process',
  boot: 'Linux: the machine rebooted during the look',
  deadline: 'the whole look ran out of time (90 s); a retry cut short reports the last whole look instead',
}

/** A live process the look read but could not judge: kept, because it may hold the folder. */
const UNKNOWN: Record<string, string> = {
  envHidden: 'macOS hides its environment, it started after the generation\'s HOME, no ancestor, launchd rule or full open-files read decides it',
  cwdUnreadable: 'its environment is not the Demo\'s but its cwd could not be read',
  unreadable: 'Linux: its /proc entries could not be read',
  raced: 'it changed while read (start time moved), or exited unread with no ancestor that decides it; the look runs again',
  rootNoGeneration: 'it carries the Demo root with no generation, so it may be this one',
}

/** Each per-process verdict: decided, or the unknown count it lands in. */
const DARWIN: Record<string, 'decided' | keyof typeof UNKNOWN> = {
  matched: 'decided', clear: 'decided', pending: 'decided',
  raced: 'raced', envHidden: 'envHidden', cwdUnreadable: 'cwdUnreadable', rootNoGeneration: 'rootNoGeneration',
  // A pid gone before it was read: its parent decides it (a readable or launchd-started one clears it), else raced.
  goneUnread: 'raced',
}
const LINUX: Record<string, 'decided' | keyof typeof UNKNOWN> = {
  skip: 'decided', match: 'decided', clear: 'decided', unreadable: 'unreadable', raced: 'raced', rootNoGeneration: 'rootNoGeneration',
}

describe('every "could not be checked" source of the Demo residual look is classified', () => {
  it('every reason a look is incomplete', () => {
    expect(union(residual, 'IncompleteWhy')).toEqual(keys(INCOMPLETE))
    const calls = [...residual.matchAll(/INCOMPLETE\(((?:[^()]|\([^()]*\))*)\)/g)].map(m => m[1]!)
    // Each call names its reason as a literal (the definition, `INCOMPLETE = (`, is no call).
    expect(calls.length).toBeGreaterThan(5)
    expect(calls.filter(arg => !/'\w+'/.test(arg))).toEqual([])
    for (const arg of calls) for (const [, why] of arg.matchAll(/'(\w+)'/g)) expect(INCOMPLETE, why).toHaveProperty(why!)
    // No incomplete report is made any other way.
    expect(residual.match(/complete: false/g)).toHaveLength(2)
    expect(residual).toContain("const INCOMPLETE = (incomplete: IncompleteWhy): Attempt => ({ complete: false,")
    expect(residual).toContain("return { supported: false, complete: false,")
  })

  it('every count of a process it could not judge', () => {
    const m = /export interface UnknownWhy \{([^}]*)\}/.exec(residual)
    expect([...m![1]!.matchAll(/(\w+): number/g)].map(x => x[1]).sort()).toEqual(keys(UNKNOWN))
  })

  it('every per-process verdict on macOS and Linux', () => {
    expect(union(residual, 'DarwinVerdict')).toEqual(keys(DARWIN))
    expect(union(residual, 'LinuxVerdict')).toEqual(keys(LINUX))
    // The counting maps the one darwin verdict that is no key of its own.
    expect(residual).toContain("out.why[verdict === 'goneUnread' ? 'raced' : verdict]++")
    for (const v of Object.values({ ...DARWIN, ...LINUX })) if (v !== 'decided') expect(UNKNOWN).toHaveProperty(v)
  })

  it('every reason a reset keeps a generation has its own line, and only demoKeptBy decides it', () => {
    const home = src('demo-home.ts')
    const kinds = union(home, 'DemoKept')
    expect(kinds).toEqual(['unknown', 'unread', 'unsupported'])
    const lines = /DEMO_KEPT_LINE: Record<DemoKept, string> = \{([\s\S]*?)\n\}/.exec(src('demo.ts'))
    expect([...lines![1]!.matchAll(/^\s+(\w+): '/gm)].map(x => x[1]).sort()).toEqual(kinds)
    const clear = home.slice(home.indexOf('export async function clearDemoHome'))
    expect(clear).not.toMatch(/return false/)
    expect(clear).toContain('const kept = demoKeptBy(report)')
  })
})
