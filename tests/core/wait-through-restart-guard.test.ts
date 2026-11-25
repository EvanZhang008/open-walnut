/**
 * Class guard: a wait on a person crosses a Walnut restart (2026-11-20: a deploy restarted the
 * server during `walnut browser request-sign-in`; the ask lived in memory only and the command gave
 * up on the first refused call, so the person was asked again). Production restarts about 60 times
 * a day, so both halves of every such wait must hold, enumerated from the source:
 *
 *  1. Every place that answers a wait on a person (`status: 'needs_ok'`, or `status: 'pending'`
 *     with a requestId) is known here with the modules that hold its asks, and those modules keep
 *     their asks with keptMap (src/core/kept-asks.ts). A module-level Map or Set there that stays
 *     in memory is listed with why a restart may forget it.
 *     The kept folder is never git-synced, and no kept value holds a token, code, secret or password
 *     in the clear (a field named so must be a hash).
 *  2. Every command loop that polls Walnut for a person's answer (the wait ops, a needs_ok) goes
 *     through src/lib/wait-through-restart.ts, and none says "lost Walnut" with words of its own.
 *
 * A new wait fails here until it keeps its asks and waits through a restart, or says why not.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8')
/** Files under src/ matching `re`, a new file not yet committed included (git grep exits 1 on none). */
function grepFiles(re: string): string[] {
  try {
    return execFileSync('git', ['grep', '--untracked', '-lE', re, '--', 'src/*.ts'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).sort()
  } catch (err) {
    if ((err as { status?: number }).status === 1) return []
    throw err
  }
}

/** Each place that answers a wait on a person, and the modules holding its asks. */
const ASK_HOLDERS: Record<string, string[]> = {
  // request_sign_in, trusted uploads, new sites (its own siteAsks), and the acts below.
  'src/web/routes/browser-v1.ts': ['src/web/routes/browser-v1.ts', 'src/core/browser-control/sign-in-ask.ts', 'src/core/browser-control/upload-grants.ts'],
  'src/core/browser-control/outward-asks.ts': ['src/core/browser-control/outward-asks.ts'],
  'src/core/browser-control/fresh-sign-in.ts': ['src/core/browser-control/fresh-sign-in.ts'],
  'src/core/browser-control/fill-login.ts': ['src/core/browser-control/fill-login.ts', 'src/core/vault/agent.ts'],
  'src/core/vault/agent.ts': ['src/core/vault/agent.ts'],
  // password_use / password_wait (only its header names the answer).
  'src/web/routes/vault-agent-v1.ts': ['src/core/vault/agent.ts'],
  // locked_note_ask / locked_note_wait (docs/reference/locked-notes.md).
  'src/core/notes/locked-note-ask.ts': ['src/core/notes/locked-note-ask.ts'],
  'src/web/routes/vault-notes-v1.ts': ['src/core/notes/locked-note-ask.ts'],
}

/** Module-level state in an ask holder that a restart may forget, and why. */
const MEMORY_OK: Record<string, Record<string, string>> = {
  'src/web/routes/browser-v1.ts': {
    lastTab: 'which browser a next command goes to: the next call picks again',
    handed: 'a tab the person handed over in the side panel: lives on the hub\'s holding, which the extension reports again',
    shareWakers: 'in-process wakers of waiting calls, which end with the process',
  },
  'src/core/browser-control/sign-in-ask.ts': {
    waiters: 'in-process wakers of waiting calls, which end with the process',
  },
  'src/core/browser-control/fill-login.ts': {
    fillTokens: 'the approval\'s wait token itself, never on disk: a restored fill waits by its hash',
  },
}

/** Loops that name a wait op or a needs_ok but wait on no person through Walnut, and why. */
const NOT_A_WAIT: Record<string, string> = {
  'src/lib/history-session-envelope.ts': 'reads a task_get call out of a transcript',
  'src/ops/tasks.ts': 'defines task_get',
  'src/providers/offline-host-core.ts': 'answers task_get from a host\'s offline copy',
}

describe('every wait on a person keeps its asks across a restart', () => {
  it('every place that answers a wait on a person is known, with the modules holding its asks', () => {
    const producers = grepFiles("status: 'needs_ok'|status: 'pending'( as const)?, requestId")
    const unknown = producers.filter((f) => !ASK_HOLDERS[f])
    expect(unknown, `${unknown.join(', ')} answer a wait on a person. Keep their asks with keptMap (src/core/kept-asks.ts) so the same request id is the same ask after a restart, then add them to ASK_HOLDERS here.`).toEqual([])
    // A stale entry is dropped here too.
    expect(Object.keys(ASK_HOLDERS).filter((f) => !producers.includes(f))).toEqual([])
  })

  it('the modules holding asks keep them, and say why any other state may be forgotten', () => {
    const holders = [...new Set(Object.values(ASK_HOLDERS).flat())].sort()
    const problems: string[] = []
    for (const f of holders) {
      const src = read(f)
      if (!/\bkeptMap(<[^>]*>)?\(/.test(src)) problems.push(`${f}: holds asks but keeps none with keptMap`)
      // Module-level state: `const x = new Map(...)` / `new Set(...)` at the start of a line,
      // except a constant set of words (`new Set<...>([`).
      for (const m of src.matchAll(/^(?:export )?(?:const|let) (\w+)\s*(?::[^=]+)?=\s*new (?:Map|Set)\b(?:<[^\n]*?>)?\((?!\[)/gm)) {
        if (!MEMORY_OK[f]?.[m[1]]) problems.push(`${f}: ${m[1]} lives in memory only: make it a keptMap, or add it to MEMORY_OK with why a restart may forget it`)
      }
    }
    expect(problems).toEqual([])
  })
})

describe('what is kept stays on this server and holds no secret', () => {
  it('the kept folder is in the data repo\'s ignore template and its critical dirs (existing repos untrack it)', () => {
    const dir = /path\.join\(WALNUT_HOME, '([a-z-]+)'/.exec(read('src/core/kept-asks.ts'))?.[1]
    expect(dir).toBe('kept-asks')
    const sync = read('src/integrations/git-sync.ts')
    expect(sync.split('\n')).toContain(`/${dir}/`)
    const critical = /const CRITICAL_IGNORE_DIRS = \[([^\]]*)\]/.exec(sync)?.[1] ?? ''
    expect(critical).toContain(`'${dir}/'`)
  })

  it('no kept map\'s value has a field named like a token, code, secret or password unless it is a hash', () => {
    const problems: string[] = []
    for (const f of grepFiles('keptMap<')) {
      if (f === 'src/core/kept-asks.ts') continue
      const src = read(f)
      for (const m of src.matchAll(/keptMap<([\s\S]*?)>\(\s*'([a-z0-9-]+)'/g)) {
        // The value's type, and the bodies of the types it names in this file.
        let text = m[1]
        for (const name of m[1].match(/\b[A-Z]\w*/g) ?? []) {
          const body = new RegExp(`(?:interface ${name}\\b[^{]*\\{|type ${name}\\b[^=]*=)([^\\n]*(?:\\n(?!\\}|\\S)[^\\n]*)*)`).exec(src)?.[1]
          if (body) text += `\n${body}`
        }
        for (const field of text.matchAll(/\b(\w*(?:token|code|secret|password|passcode|totp)\w*)\??\s*:/gi)) {
          if (!/hash$/i.test(field[1])) problems.push(`${f} keptMap '${m[2]}': field ${field[1]} would be written in the clear: keep its hash, or keep it in memory only`)
        }
      }
    }
    expect(problems).toEqual([])
  })
})

describe('every command that waits on a person waits through a restart', () => {
  it('every loop that polls a wait op or a needs_ok goes through wait-through-restart.ts', () => {
    const waitOps = [...new Set(execFileSync('git', ['grep', '--untracked', '-hoE', "name: '[a-z_]+_wait'", '--', 'src/ops'], { cwd: root, encoding: 'utf8' })
      .split('\n').filter(Boolean).map((l) => l.slice("name: '".length, -1)))].sort()
    // The person-answer wait ops, read from the op registry, plus the reply and task reads `wait` polls.
    expect(waitOps).toEqual(['approval_wait', 'locked_note_wait', 'password_wait'])
    const named = grepFiles(`'(${[...waitOps, 'request_get', 'task_get'].join('|')})'|=== 'needs_ok'`)
    const loops = named.filter((f) => /for \(;;\)|while \(/.test(read(f)))
    const problems: string[] = []
    for (const f of loops) {
      if (NOT_A_WAIT[f]) continue
      if (!read(f).includes('lib/wait-through-restart.js')) problems.push(`${f}: polls Walnut for an answer: wait through a restart with waitThroughRestart (src/lib/wait-through-restart.ts), or add it to NOT_A_WAIT with why it is no wait`)
    }
    expect(problems).toEqual([])
    expect(Object.keys(NOT_A_WAIT).filter((f) => !loops.includes(f))).toEqual([])
  })

  it('no copy of the helper: only it says "lost Walnut for a moment"', () => {
    expect(grepFiles('lost Walnut for a moment')).toEqual(['src/lib/wait-through-restart.ts'])
  })
})
