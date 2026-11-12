/**
 * No Walnut program on a Mac asks again for local network access after the user's one choice.
 *
 * macOS Local Network privacy asks for the program it holds responsible for a connection, and keys
 * an unbundled program's choice on its path. Walnut.app answers for everything run under its
 * session host, once; a compiled walnut file run as its own program is asked for its own path, and
 * a deploy's stage is a new path every time. 2026-11-12 (the user: "every day bro"): the deploy ran
 * the smoke boot straight from the file, from the land queue (a launchd agent, its own responsible
 * program), and the smoke server's daemon probed the cloud metadata address 169.254.169.254, so
 * macOS asked "Allow walnut-darwin-arm64 to find devices on local networks?" for that stage; a
 * rollback the day before did the same.
 *
 * Two halves of the class, each enumerated from the source so a new member fails here:
 *  1. every run of a compiled file in scripts/dev-prod.sh goes through the session host
 *     (host_prefix_for / session_host_prefix), or says on the line above why it runs plain;
 *  2. every local-network address literal in src/ is a site listed here with why it never makes
 *     a Mac program ask on its own.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.join(import.meta.dirname, '..', '..')
const script = fs.readFileSync(path.join(REPO, 'scripts', 'dev-prod.sh'), 'utf8')
const lines = script.split('\n')

/** A quoted shell word that runs a Walnut program: a variable, then a Walnut subcommand. */
const RUN = /"\$\{?[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?(:[0-9:]+)?\}?" (web|mcp|tools|__[a-z][a-z-]*)\b/

interface Run { line: number; text: string }

function runsOfAFile(): Run[] {
  const out: Run[] = []
  lines.forEach((text, i) => {
    const code = text.replace(/^\s*#.*$/, '')
    if (!RUN.test(code)) return
    // Handing the argv to the approval helper is not a run of the file.
    if (/^\s*host_prefix_for /.test(code)) return
    out.push({ line: i + 1, text: text.trim() })
  })
  return out
}

/** The command a line belongs to (back over `\\` continuations and an array literal still open), and the two lines above it. */
function commandOf(lineNo: number): { above: string[]; cmd: string[] } {
  let start = lineNo - 1
  while (start > 0 && /\\\s*$/.test(lines[start - 1]!)) start--
  for (let back = start - 1; back >= Math.max(0, start - 16); back--) {
    const l = lines[back]!
    if (l.trim() === '' || /\)\s*$/.test(l)) break
    if (/\w=\(/.test(l)) { start = back; break }
  }
  return { above: lines.slice(Math.max(0, start - 2), start), cmd: lines.slice(start, lineNo) }
}

describe('every run of a compiled file in the deploy goes through Walnut.app', () => {
  const runs = runsOfAFile()

  it('finds the runs (the scan itself works)', () => {
    const names = runs.map((r) => r.text)
    for (const want of ['__selftest', '__plugin-check', '__session-host-approve', 'web --port "$smoke_port"', 'web --port "$PORT"']) {
      expect(names.some((n) => n.includes(want)), `a run with ${want}`).toBe(true)
    }
  })

  for (const run of runsOfAFile()) {
    it(`dev-prod.sh:${run.line} ${run.text.slice(0, 70)}`, () => {
      const { above, cmd } = commandOf(run.line)
      const own = lines[run.line - 1]!
      const before = cmd.slice(0, -1).join('\n') + '\n' + own.slice(0, own.search(RUN))
      // The host's prefix must be part of this command, in front of the file, never an argument after it.
      const viaHost = before.includes('${host_prefix[@]+"${host_prefix[@]}"}')
      const plain = [...above, ...cmd].map((l) => /^\s*#\s*runs-plain:\s*(.+)$/.exec(l)?.[1]).find(Boolean)
      expect(viaHost || (plain !== undefined && plain.length >= 20),
        `dev-prod.sh:${run.line} runs a compiled file as its own program: put \${host_prefix[@]+"\${host_prefix[@]}"} (from host_prefix_for) between its env and the file, or say why on a "# runs-plain:" line above it`).toBe(true)
    })
  }

  it('the other deploy scripts run no compiled file themselves', () => {
    const others = ['scripts/deploy-committed.sh', ...fs.readdirSync(path.join(REPO, 'scripts', 'lib')).filter((f) => f.endsWith('.sh')).map((f) => `scripts/lib/${f}`)]
    for (const rel of others) {
      const hits = fs.readFileSync(path.join(REPO, rel), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l) && RUN.test(l))
      expect(hits, `${rel} runs a compiled file: route it through dev-prod.sh's host_prefix_for`).toEqual([])
    }
  })

  it('each run under the host first approves the same argv, and falls back on the host\'s refusal (125)', () => {
    for (const sub of ['__selftest', '__plugin-check', 'web --port "$smoke_port"']) {
      expect(script).toMatch(new RegExp(`host_prefix_for --once "\\$SERVER_FILE" ${sub.replace(/[$"]/g, (c) => `\\${c}`)}`))
    }
    for (const what of ['self-test', 'smoke boot', 'plugin check']) {
      expect(script, `the ${what} falls back on a refusal`).toMatch(new RegExp(`session host refused the ${what} \\(exit 125\\)`))
    }
    // A rollback leaves the host on any failure, not only a refusal (tested in dev-prod-session-host.test.ts).
    expect(script).toMatch(/The rollback server did not come up under Walnut\.app's session host; starting it directly/)
  })

  it('a forced end of a run under the host takes the file with it', () => {
    expect(script).toMatch(/smoke_cleanup\(\) \{[\s\S]*?kill_with_children 9 "\$SMOKE_PID"/)
    expect(script).toMatch(/plugin_check_cleanup\(\) \{[\s\S]*?kill_with_children 9 "\$PLUGIN_CHECK_PID"/)
  })
})

/**
 * Where src/ names a local-network address (link-local, private ranges, multicast) as a place to
 * connect, and why no Mac program asks the user for it on its own. A new site fails until it is
 * listed with its reason.
 */
const LOCAL_NETWORK_SITES: Record<string, string> = {
  'src/providers/host-facts-core.ts': 'the daemon\'s cloud metadata probe, never sent on macOS (tested in tests/providers/host-facts-core.test.ts)',
  'src/core/cloud-setup/providers/aws-target.ts': 'the instance region read, only on an EC2 instance (detectEc2, false on macOS)',
  'src/core/cloud-setup/user-data.ts': 'a shell script for the cloud instance\'s first boot, run there, never on this Mac',
}
const ADDRESS = /(['"`/]|\b)(169\.254\.\d+\.\d+|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|224\.0\.0\.\d+|239\.255\.255\.250|ff02::[0-9a-f]*|fe80::)/i

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p)
  }
  return out
}

describe('no Walnut program on a Mac connects to the local network on its own', () => {
  it('every local-network address literal in src/ is a listed site (an address found at run time, like the gateway, is not seen here)', () => {
    const found = new Set<string>()
    for (const file of sourceFiles(path.join(REPO, 'src'))) {
      const text = fs.readFileSync(file, 'utf8')
      const code = text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
      if (ADDRESS.test(code)) found.add(path.relative(REPO, file))
    }
    const unlisted = [...found].filter((f) => !(f in LOCAL_NETWORK_SITES))
    expect(unlisted, 'a new local-network address in src/: make sure a Mac never connects to it from a program no app answers for, then list the file here with why').toEqual([])
    const gone = Object.keys(LOCAL_NETWORK_SITES).filter((f) => !found.has(f))
    expect(gone, 'listed sites that no longer name an address: remove them from the list').toEqual([])
  })

  it('the daemon\'s cloud probe is skipped on macOS', () => {
    const facts = fs.readFileSync(path.join(REPO, 'src/providers/host-facts-core.ts'), 'utf8')
    expect(facts).toMatch(/if \(network && deps\.platform === 'darwin'\) out\.cloud = \{ imds: false \}\n\s*else if \(network\) tasks\.push\(probe\(cloud/)
  })
})
