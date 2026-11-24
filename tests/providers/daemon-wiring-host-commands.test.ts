/**
 * Text ratchets on the session daemon's host-local commands (transcript probe, grep, git history, file mutation, external session scan, usage scans) and the caller identity rules.
 *
 * Source text is checked where no behavior test reaches the line (the guard names which
 * test covers the behavior when one does). The daemon is one program: nothing here
 * compares two copies.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { readTwinText } from '../helpers/standalone-twin-text.js'
import { ADVERTISED_DAEMON_CAPABILITIES, REQUIRED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'

const ROOT = path.resolve(__dirname, '../..')

// daemon-standalone.ts reads as the whole runtime, its area modules included (readTwinText).
const readFile = readTwinText

describe('daemon wiring: host-local commands (transcript, grep, git, fs, external scan)', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))

  // Host-local transcript rewind probe (transcript.rewindProbe). Without it the
  // server must shuttle a whole transcript over the tunnel, which DaemonFileReader
  // refuses past its byte ceiling, so rewind on a long transcript depends entirely
  // on this capability reaching hosts, i.e. on the version hash below.
  it("daemon: dispatch transcript.rewindProbe; 'rewind-probe-v1' is advertised, NOT required", () => {
    expect(standaloneSrc).toMatch(/'transcript\.rewindProbe': cmdTranscriptRewindProbe\b/)
    expect(standaloneSrc).toMatch(/function cmdTranscriptRewindProbe/)
    // The daemon imports the core.
    expect(standaloneSrc).toMatch(/from '\.\/transcript-rewind-core\.js'/)
    // Advertised, never required — an old daemon stays usable (server falls back).
    const capsSrc = readFile(path.join(ROOT, 'src/providers/daemon-capabilities.ts'))
    const reqStart = capsSrc.indexOf('REQUIRED_DAEMON_CAPABILITIES = [')
    expect(reqStart).toBeGreaterThan(-1)
    expect(capsSrc.slice(reqStart, capsSrc.indexOf('] as const', reqStart)))
      .not.toMatch(/'rewind-probe-v1'/)
    const advStart = capsSrc.indexOf('ADVERTISED_DAEMON_CAPABILITIES = [')
    expect(capsSrc.slice(advStart, capsSrc.indexOf('] as const', advStart)))
      .toMatch(/'rewind-probe-v1'/)
    // Version hash (both lists).
    const build = readFile(path.join(ROOT, 'scripts/build-daemon.sh'))
    expect(build).toMatch(/src\/providers\/transcript-rewind-core\.ts/)
    expect(build).toMatch(/src\/core\/transcript-chain\.ts/)
    const versionCheck = readFile(path.join(ROOT, 'src/providers/daemon-version-check.ts'))
    expect(versionCheck).toMatch(/transcript-rewind-core\.ts/)
    expect(versionCheck).toMatch(/transcript-chain\.ts/)
  })

  // Concurrency: the probe streams the same transcripts changes.compute walks, so
  // it takes the same gate. It matters most on the DISPLAY caller (history reads
  // poll), where a burst would otherwise stack whole-file parses on the host.
  it('daemon: serialize transcript.rewindProbe and coalesce identical requests', () => {
    // Host-wide serial gate + per-request in-flight map, and the command must
    // go THROUGH the gate (a direct core call would bypass both).
    expect(standaloneSrc).toMatch(/rewindProbeInflight(: Promise<void>)? = Promise\.resolve\(\)/)
    expect(standaloneSrc).toMatch(/rewindProbeInflightByKey = new Map/)
    expect(standaloneSrc).toMatch(/function probeTranscriptRewindGated/)
    expect(standaloneSrc).toMatch(/await probeTranscriptRewindGated\(/)
    // Keyed on the whole request: two callers asking different questions about
    // one session must not share an answer.
    expect(standaloneSrc).toMatch(/function rewindProbeKey/)
    expect(standaloneSrc).toMatch(/c\.uuid \+ '>' \+ c\.lastUuidAtCommit/)
    // Still UNCACHED — the gate bounds concurrency, it never serves stale answers.
    expect(standaloneSrc).not.toMatch(/rewindProbeCache/)
  })

  // Host-local symbol search (fs.grep): the daemon imports search-grep-core.ts.
  // 'grep-v1' is unconditional on a current daemon, and still
  // advertised-not-required so old ones stay usable.
  it("daemon: dispatch fs.grep; 'grep-v1' advertised but NOT required", () => {
    expect(standaloneSrc).toMatch(/'fs\.grep': cmdFsGrep\b/)
    expect(standaloneSrc).toMatch(/function cmdFsGrep/)
    // The daemon uses the shared core.
    expect(standaloneSrc).toMatch(/from '\.\/search-grep-core\.js'/)
    // Advertised, never required — an old daemon must stay usable.
    const capsSrc = readFile(path.join(ROOT, 'src/providers/daemon-capabilities.ts'))
    const reqStart = capsSrc.indexOf('REQUIRED_DAEMON_CAPABILITIES = [')
    expect(reqStart).toBeGreaterThan(-1)
    expect(capsSrc.slice(reqStart, capsSrc.indexOf('] as const', reqStart)))
      .not.toMatch(/'grep-v1'/)
    const advStart = capsSrc.indexOf('ADVERTISED_DAEMON_CAPABILITIES = [')
    expect(capsSrc.slice(advStart, capsSrc.indexOf('] as const', advStart)))
      .toMatch(/'grep-v1'/)
    // The core must be hashed into the daemon version, or a classifier edit
    // ships without any daemon self-upgrading.
    expect(readFile(path.join(ROOT, 'scripts/build-daemon.sh')))
      .toMatch(/search-grep-core\.ts/)
    expect(readFile(path.join(ROOT, 'src/providers/daemon-version-check.ts')))
      .toMatch(/search-grep-core\.ts/)
  })

  // Host-local git history for ONE file (git.fileLog / git.fileShow): the Files
  // panel's History timeline. Same inline shape as fs.grep — the daemon run git
  // themselves over child_process, so 'git-file-history-v1' is unconditional on a
  // current daemon. The sha check is the security-relevant
  // half: that string reaches a `git show <sha>:<path>` argument, so the daemon
  // must refuse a non-sha BEFORE spawning anything.
  it("daemon: dispatch git.fileLog/git.fileShow; 'git-file-history-v1' advertised but NOT required", () => {
    expect(standaloneSrc).toMatch(/'git\.fileLog': cmdGitFileLog\b/)
    expect(standaloneSrc).toMatch(/'git\.fileShow': cmdGitFileShow\b/)
    expect(standaloneSrc).toContain('git.answers]')
    // The commands live in the runtime's git module (daemon-git.ts).
    const gitSrc = readFile(path.join(ROOT, 'src/providers/daemon-git.ts'))
    expect(gitSrc).toMatch(/function cmdGitFileLog/)
    expect(gitSrc).toMatch(/function cmdGitFileShow/)
    // Validate-then-spawn: the regex, the refusal, and the same `--follow` log
    // format on both sides (a one-sided format edit silently changes parsing).
    expect(gitSrc).toContain('GIT_FILE_SHA_RE = /^[0-9a-f]{7,40}$/')
    expect(gitSrc).toContain("'git.fileShow: invalid sha'")
    expect(gitSrc).toContain("GIT_FILE_LOG_FORMAT = '%H%x1f%ct%x1f%an%x1f%s'")
    expect(gitSrc).toMatch(/'--follow'/)
    // Bounded: a timeout and a maxBuffer on every invocation, and a hard cap on
    // the version being shown (the editor could not hold more anyway).
    expect(gitSrc).toMatch(/GIT_FILE_SHOW_MAX_BYTES = 8 \* 1024 \* 1024/)
    expect(gitSrc).toMatch(/timeout: 8_?000/)
    // `~` expansion, like every other path-taking command (the shared expandHome).
    expect(gitSrc).toMatch(/expandHome\(rawCwd, HOME_DIR\)/)
    expect(gitSrc).toMatch(/expandHome\(rawPath, HOME_DIR\)/)
    // A path git never tracked is "no history", never an error response.
    expect(gitSrc).toMatch(/commits: \[\] \}\)/)
    // The server's own reader must carry the SAME sha rule (it feeds the same
    // `git show` argument for a __local__ path).
    expect(readFile(path.join(ROOT, 'src/core/file-history-git.ts')))
      .toContain('GIT_SHA_RE = /^[0-9a-f]{7,40}$/')
    // Advertised, never required — an old daemon must stay usable (the History
    // panel degrades to Walnut's own snapshots).
    const capsSrc = readFile(path.join(ROOT, 'src/providers/daemon-capabilities.ts'))
    const reqStart = capsSrc.indexOf('REQUIRED_DAEMON_CAPABILITIES = [')
    expect(reqStart).toBeGreaterThan(-1)
    expect(capsSrc.slice(reqStart, capsSrc.indexOf('] as const', reqStart)))
      .not.toMatch(/'git-file-history-v1'/)
    const advStart = capsSrc.indexOf('ADVERTISED_DAEMON_CAPABILITIES = [')
    expect(capsSrc.slice(advStart, capsSrc.indexOf('] as const', advStart)))
      .toMatch(/'git-file-history-v1'/)
  })
  it('daemon: keeps the file-history family off the cloud bridge', () => {
    const allowStart = standaloneSrc.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([')
    expect(allowStart).toBeGreaterThan(-1)
    const allowBody = standaloneSrc.slice(allowStart, standaloneSrc.indexOf('])', allowStart))
    for (const cmd of ["'git.fileLog'", "'git.fileShow'"]) {
      expect(allowBody, `${cmd} reads arbitrary host paths — never from a compromised cloud box`)
        .not.toContain(cmd)
    }
  })


  // External-session scan (sessions.discoverExternal).
  it("daemon: dispatch sessions.discoverExternal; 'external-scan-v1' is advertised, NOT required", () => {
    expect(standaloneSrc).toMatch(/'sessions\.discoverExternal': cmdDiscoverExternalSessions\b/)
    expect(standaloneSrc).toMatch(/function cmdDiscoverExternalSessions/)
    // Serialized daemon-wide: concurrent walks over thousands of transcript
    // files would be the same starvation shape changes-v1 guards against.
    expect(standaloneSrc).toMatch(/externalScanInflight/)
    expect(standaloneSrc).toMatch(/cmd\.excludedCwds/)
    expect(standaloneSrc).toMatch(/knownSessionIds[^\n]*excludedCwds/)
    // Optional, never required — an old daemon must stay usable.
    const capsSrc = readFile(path.join(ROOT, 'src/providers/daemon-capabilities.ts'))
    const reqStart = capsSrc.indexOf('REQUIRED_DAEMON_CAPABILITIES = [')
    expect(capsSrc.slice(reqStart, capsSrc.indexOf('] as const', reqStart)))
      .not.toMatch(/'external-scan-v1'/)
    const advStart = capsSrc.indexOf('ADVERTISED_DAEMON_CAPABILITIES = [')
    expect(capsSrc.slice(advStart, capsSrc.indexOf('] as const', advStart)))
      .toMatch(/'external-scan-v1'/)
  })

  // Bridge bounded file read (cloud replica phone file previews): the ONLY
  // generic-content read a bridge socket may invoke. Lock the containment
  // shape on the daemon: allowlist membership, dispatch case, 2MB cap,
  // realpath-then-denylist ordering, secret-path denylist, regular-files-only
  // stat gate, and that unbounded fs.read stays OFF the bridge.
  it('daemon: allowlist fs.readBounded on the bridge and dispatch it', () => {
    const allowStart = standaloneSrc.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([')
    expect(allowStart).toBeGreaterThan(-1)
    const allowBody = standaloneSrc.slice(allowStart, standaloneSrc.indexOf('])', allowStart))
    expect(allowBody).toContain("'fs.readBounded'")
    // Containment intact: the unbounded read stays off the bridge.
    expect(allowBody).not.toContain("'fs.read'")
    expect(allowBody).not.toContain("'fs.readRange'")
    expect(standaloneSrc).toMatch(/'fs\.readBounded': cmdFsReadBounded\b/)
    expect(standaloneSrc).toMatch(/function cmdFsReadBounded/)
  })
  it('daemon: enforce the same fs.readBounded cap, sandbox ordering, and denylist', () => {
    expect(standaloneSrc).toMatch(/FS_READ_BOUNDED_MAX_BYTES = 2 \* 1024 \* 1024/)
    // Denylist covers the key-material dirs and file classes.
    expect(standaloneSrc).toMatch(/FS_READ_BOUNDED_DENIED_DIRS = \['\.ssh', '\.aws', '\.gnupg'/)
    for (const lit of ["'.netrc'", "'auth.json'", "'bridge-tokens.json'", "'pem'", "'ppk'"]) {
      expect(standaloneSrc).toContain(lit)
    }
    expect(standaloneSrc).toMatch(/\^id_\(rsa\|dsa\|ecdsa\|ed25519\)/)
    expect(standaloneSrc).toMatch(/\^config\\\.ya\?ml\$/)
    const body = standaloneSrc.slice(standaloneSrc.search(/function cmdFsReadBounded/), standaloneSrc.indexOf('\n}', standaloneSrc.search(/function cmdFsReadBounded/)))
    // realpath BEFORE the denylist (symlink laundering) …
    const realpathIdx = body.indexOf('realpath(filePath)')
    const denyIdx = body.indexOf('fsReadBoundedDenied(resolved)')
    expect(realpathIdx).toBeGreaterThan(-1)
    expect(denyIdx).toBeGreaterThan(realpathIdx)
    // …then stat-before-open (FIFO guard) and the size cap before the read.
    const statIdx = body.indexOf('stat(resolved)')
    const readIdx = body.indexOf('readFile(resolved)')
    expect(statIdx).toBeGreaterThan(denyIdx)
    expect(body.indexOf('FS_READ_BOUNDED_MAX_BYTES')).toBeGreaterThan(statIdx)
    expect(readIdx).toBeGreaterThan(statIdx)
    // Traversal + absolute checks are present.
    expect(body).toContain("includes('..')")
    expect(body).toContain('isAbsolute(filePath)')
  })

  // File MUTATION family (fs.rename / fs.rm / fs.copy, 'fs-mutate-v1'): the
  // Files panel's rename/duplicate/delete. Behavior is covered by
  // daemon-fs-mutate.test.ts; these byte checks pin the shapes it cannot reach. Every clause below is a data-loss shape:
  // the floor (EDENIED) stops a mutation aimed at '/' or a home directory, and
  // errorOnExist + the lstat pre-checks stop a rename/copy from silently
  // replacing another file.
  it('daemon: dispatch fs.rename / fs.rm / fs.copy and share the mutation floor', () => {
    expect(standaloneSrc).toContain("'fs.rename': cmdFsRename")
    expect(standaloneSrc).toContain("'fs.rm': cmdFsRm")
    expect(standaloneSrc).toContain("'fs.copy': cmdFsCopy")
    expect(standaloneSrc).toMatch(/function fsMutateFloor/)
    expect(standaloneSrc).toMatch(/function cmdFsRename/)
    expect(standaloneSrc).toMatch(/function cmdFsRm/)
    expect(standaloneSrc).toMatch(/function cmdFsCopy/)
    // Every mutating command must consult the floor and refuse with EDENIED:
    // fs.rename / fs.rm / fs.copy, plus fs.write and fs.mkdir on their
    // `exclusive` (Files-panel create) branch. Creating a file was once the one
    // mutation with NO host-side check, which is also what the capability blurb
    // already claimed was covered.
    expect((standaloneSrc.match(/refused: path outside the mutation floor \(EDENIED\)/g) ?? []).length,
      'fs.rename/fs.rm/fs.copy plus exclusive fs.write/fs.mkdir must each refuse with EDENIED').toBe(5)
    // The floor must be applied to the path the KERNEL reaches, not the string:
    // without resolving the parent, one symlinked ancestor carries any target
    // past every rule below (a link to the home directory made `~/.ssh`
    // deletable through a request that looked entirely ordinary).
    expect(standaloneSrc, 'the resolving wrapper must exist').toMatch(/function fsMutateResolve/)
    expect(standaloneSrc, 'the parent must be realpath-ed before the checks')
      .toMatch(/realpath\(path\.dirname\(p\)\)/)
    // …and every destructive command must go through the RESOLVING wrapper,
    // never the bare string floor.
    expect((standaloneSrc.match(/await fsMutateResolve\(/g) ?? []).length,
      'rename(2) + rm(1) + copy(2) + write(1) + mkdir(1) call sites').toBe(7)
    // The host-side denylist. The SERVER's copy is built from the server's own
    // home directory, so on a remote host it compares a Linux path against a
    // Mac home and matches nothing — this is the only thing protecting that
    // host's credentials and Walnut's own stream JSONLs.
    expect(standaloneSrc, 'host-side denylist must exist').toMatch(/function fsMutateDenied/)
    expect(standaloneSrc).toMatch(/seg === '\.ssh'/)
    expect(standaloneSrc).toContain('open-walnut-streams')
    // Never-clobber: an existing target is an EEXIST, and cp is asked to fail
    // on an existing entry rather than merge into it.
    expect(standaloneSrc).toContain('errorOnExist: true')
    expect((standaloneSrc.match(/target already exists \(EEXIST\)/g) ?? []).length).toBe(2)
    expect(standaloneSrc).toContain('target is a directory (EISDIR)')
    // The floor's segment-wise '.'/'..' rule (a substring check would reject
    // an ordinary name like 'mod..old') and its two-segment minimum.
    expect(standaloneSrc).toMatch(/seg === '\.' \|\| seg === '\.\.'/)
    expect(standaloneSrc).toMatch(/\.length > 0\)\.length < 2\) return (?:null|false)/)
  })
  it('daemon: keeps the mutation family off the cloud bridge', () => {
    const allowStart = standaloneSrc.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([')
    expect(allowStart).toBeGreaterThan(-1)
    const allowBody = standaloneSrc.slice(allowStart, standaloneSrc.indexOf('])', allowStart))
    for (const cmd of ["'fs.rename'", "'fs.rm'", "'fs.copy'", "'fs.mkdir'"]) {
      expect(allowBody, `${cmd} must never be reachable from a compromised cloud box`)
        .not.toContain(cmd)
    }
  })
  // Conditional/atomic fs.write ('fs-write-atomic-v1'): the server edits engine
  // config files a RUNNING CLI watches and rewrites. Behavior is covered by
  // daemon-fs-write-atomic.test.ts; these byte checks pin the shapes it cannot reach. Both clauses are data-loss shapes —
  // without the precondition a concurrent edit is clobbered, and without the
  // rename the watcher reads a half-written file as invalid JSON.
  it('daemon: carry the EMODIFIED precondition and the tmp→rename swap in cmdFsWrite', () => {
    const start = standaloneSrc.search(/function cmdFsWrite/)
    expect(start).toBeGreaterThan(-1)
    const body = standaloneSrc.slice(start, standaloneSrc.indexOf('\n}', start))
    // The refusal string the server matches on — a reworded one is a silent
    // downgrade to clobbering.
    expect(body).toContain('EMODIFIED')
    // Temp file in the target's own directory, then an atomic rename over it.
    expect(body).toContain(".walnut-'")
    expect(body).toMatch(/rename\(tmpPath, target\)/)
    // ORDER is the contract, not presence: the link is resolved before anything
    // reads or renames; the regular-file gate runs before the hash's open();
    // the refusal runs before mkdir (a refusal leaves no trace); data is synced
    // and the mode restored before the rename publishes the file.
    const steps = [
      'realpath(target)',
      'isFile()',
      'ENOTFILE',
      'createHash(\'sha256\').update(await fs.promises.readFile(target))',
      'EMODIFIED',
      'mkdir(path.dirname(target)',
      'sweepStaleWriteTemps(',
      'fh.sync()',
      'chmod(tmpPath',
      'rename(tmpPath, target)',
    ]
    const positions = steps.map((s) => body.indexOf(s))
    for (let i = 0; i < steps.length; i++) {
      expect(positions[i], `${steps[i]} missing from cmdFsWrite`).toBeGreaterThan(-1)
      if (i > 0) expect(positions[i], `${steps[i]} must come after ${steps[i - 1]}`).toBeGreaterThan(positions[i - 1])
    }
    // The sweep helper itself exists on both sides with the same staleness rule.
    expect(standaloneSrc).toMatch(/FS_WRITE_TEMP_STALE_MS = 60 \* 60 \* 1000/)
    expect(standaloneSrc).toMatch(/FS_WRITE_PRECONDITION_MAX_BYTES = 32 \* 1024 \* 1024/)
    // Advertised, never required — an old daemon must stay usable (the route
    // answers 501 daemon_needs_upgrade until the next auto-deploy).
    const capsSrc = readFile(path.join(ROOT, 'src/providers/daemon-capabilities.ts'))
    const reqStart = capsSrc.indexOf('REQUIRED_DAEMON_CAPABILITIES = [')
    expect(reqStart).toBeGreaterThan(-1)
    expect(capsSrc.slice(reqStart, capsSrc.indexOf('] as const', reqStart)))
      .not.toMatch(/'fs-write-atomic-v1'/)
    const advStart = capsSrc.indexOf('ADVERTISED_DAEMON_CAPABILITIES = [')
    expect(capsSrc.slice(advStart, capsSrc.indexOf('] as const', advStart)))
      .toMatch(/'fs-write-atomic-v1'/)
  })

  // git.ensureExcluded ('git-exclude-v1'): a project settings file Walnut just
  // created must not show up as an untracked file in the user's repo. Behavior
  // is covered by daemon-git-ensure-excluded.test.ts; this pins the decision
  // order, which is what keeps it from
  // ever touching a tracked file or a .gitignore.
  it('daemon: dispatch git.ensureExcluded with the same check order and keep it off the bridge', () => {
    expect(standaloneSrc).toMatch(/'git\.ensureExcluded': cmdGitEnsureExcluded\b/)
    const gitSrc = readFile(path.join(ROOT, 'src/providers/daemon-git.ts'))
    const start = gitSrc.search(/async function cmdGitEnsureExcluded/)
    expect(start).toBeGreaterThan(-1)
    const body = gitSrc.slice(start, gitSrc.indexOf('\n  }\n', start))
    // ORDER: repo root first (not-a-repo is an answer, not an error), the file
    // must sit inside it, an ignored or tracked file is left alone, and only
    // then is the exclude file located and appended to.
    const steps = [
      "'rev-parse', '--show-toplevel'",
      "'not-a-repo'",
      'outside the repository',
      "'check-ignore', '-q', '--', rel",
      "'ls-files', '--error-unmatch', '--', rel",
      "'rev-parse', '--git-path', 'info/exclude'",
      "'/' + rel",
      "'added'",
    ]
    const positions = steps.map((s) => body.indexOf(s))
    for (let i = 0; i < steps.length; i++) {
      expect(positions[i], `${steps[i]} missing from cmdGitEnsureExcluded`).toBeGreaterThan(-1)
      if (i > 0) expect(positions[i], `${steps[i]} must come after ${steps[i - 1]}`).toBeGreaterThan(positions[i - 1])
    }
    // Never a .gitignore edit: that file is the user's, and often committed.
    expect(body).not.toContain('.gitignore')
    // Off the bridge: a cloud client must not be able to write into a repo's .git.
    const allowStart = standaloneSrc.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([')
    expect(standaloneSrc.slice(allowStart, standaloneSrc.indexOf('])', allowStart))).not.toContain("'git.ensureExcluded'")
    const capsSrc = readFile(path.join(ROOT, 'src/providers/daemon-capabilities.ts'))
    const reqStart = capsSrc.indexOf('REQUIRED_DAEMON_CAPABILITIES = [')
    expect(capsSrc.slice(reqStart, capsSrc.indexOf('] as const', reqStart))).not.toMatch(/'git-exclude-v1'/)
    const advStart = capsSrc.indexOf('ADVERTISED_DAEMON_CAPABILITIES = [')
    expect(capsSrc.slice(advStart, capsSrc.indexOf('] as const', advStart))).toMatch(/'git-exclude-v1'/)
  })


  it('daemon: scrub WALNUT_RUNTIME_DIR from the CLI spawn env', () => {
    // A compiled-file daemon runs with the serving stage's runtime dir; a session
    // that inherited it unpacked a `walnut` into that stage, or mkdir'd it back
    // inside a stage the next deploy had deleted (scripts/dev-prod.sh).
    // The CLI's own env object: from the one key only it sets to its closing brace.
    const at = standaloneSrc.indexOf('WALNUT_AGENT_SOCKET: GATEWAY_SOCK_PATH')
    expect(at).toBeGreaterThan(0)
    const start = standaloneSrc.lastIndexOf('env: {', at)
    const end = standaloneSrc.indexOf('\n    },', at)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(at)
    const envObject = standaloneSrc.slice(start, end)
    expect(envObject).toContain('...process.env')
    // Unset, except a service set's own runtime place (service-set.ts setRuntimeTreesDirOf:
    // undefined unless the daemon is a set's and its dir is that set's), so a set's sessions
    // never unpack into the default Walnut's runtime.
    expect(envObject).toMatch(/\bWALNUT_RUNTIME_DIR:\s*SESSION_RUNTIME_DIR\b/)
    expect(fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf-8')).toMatch(/const SESSION_RUNTIME_DIR = setRuntimeTreesDirOf\(daemonEnv, fs\.realpathSync\)/)
  })

  it('daemon: scrub WALNUT_DAEMON_PARENT_PID from the CLI spawn env', () => {
    // Env-carrier chain: isolated daemon → CLI → `npm run dev:prod` → PROD daemon
    // inherits a dead parent pid, watchdog trips, prod sessions die.
    expect(standaloneSrc).toMatch(/WALNUT_DAEMON_PARENT_PID:\s*undefined/)
  })
})

describe('session cost day split (session-cost-day-v1)', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))

  it('daemon: pass byDay through to scanSessionCost', () => {
    const start = standaloneSrc.indexOf('async function cmdUsageSessionCost(')
    expect(start).toBeGreaterThan(-1)
    const body = standaloneSrc.slice(start, standaloneSrc.indexOf('\n}\n', start))
    expect(body).toMatch(/scanSessionCost\(\{/)
    expect(body).toMatch(/byDay: \{ timeZone: \(?cmd\.byDay/)
  })


  // A host without procps answers `ps` with "ps: not found" on stderr, and a
  // daemon that let it through wrote that line into its log on every check.
  it('every ps the daemon runs keeps its stderr out of the daemon\'s own (the daemon and its core)', () => {
    for (const file of ['src/providers/daemon-standalone.ts', 'src/providers/daemon-core.ts']) {
      const src = readFile(path.join(ROOT, file))
      const calls = [...src.matchAll(/execFileSync\('ps',[\s\S]*?\)\)?[;\n]/g)].map((m) => m[0])
      expect(calls.length, file).toBeGreaterThan(0)
      for (const call of calls) expect(call, `${file}: ${call.slice(0, 120)}`).toContain("stdio: ['ignore', 'pipe', 'ignore']")
    }
  })
})

// Optional features an older daemon may lack: advertised by this daemon, never required of one
// (a required one would refuse every older daemon's connect; one not advertised turns its feature off).
describe('optional capabilities stay advertised and not required', () => {
  it.each(['triggers-v1', 'session-cost-day-v1', 'codex-outside-v1', 'claude-outside-v1'])('%s', (cap) => {
    expect(REQUIRED_DAEMON_CAPABILITIES as readonly string[]).not.toContain(cap)
    expect(ADVERTISED_DAEMON_CAPABILITIES as readonly string[]).toContain(cap)
  })
})

describe('codex outside usage (codex-outside-v1)', () => {
  // The whole runtime: daemon-standalone.ts and its area modules (the usage scans are daemon-changes.ts).
  const standalone = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
  it('daemon: route usage.codexOutside to the shared scan with the same request fields', () => {
    expect(standalone).toMatch(/'usage\.codexOutside': cmdUsageCodexOutside\b/)
    for (const field of ['byDay', 'thresholds', 'knownSessionIds', 'since', 'cursor', 'budgetMs']) {
      expect(standalone).toMatch(new RegExp(`scanCodexOutside\\(\\{[\\s\\S]{0,900}${field}`))
    }
    // Read-only: the scan names no write call.
    const core = fs.readFileSync(path.join(ROOT, 'src/providers/codex-outside-core.ts'), 'utf8')
    expect(core).not.toMatch(/writeFile|appendFile|unlink|rename\(|rm\(|mkdir|O_WRONLY|O_RDWR|O_CREAT/)
  })
})

describe('claude outside usage (claude-outside-v1)', () => {
  // The whole runtime: daemon-standalone.ts and its area modules (the usage scans are daemon-changes.ts).
  const standalone = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
  it('daemon: hand the outside flag, and only a true one, to the shared usage scan', () => {
    expect(standalone).toMatch(/cmd\.outside === true \? \{ outside: true \} : \{\}/)
  })

  it('the listing reads transcripts and writes only its own cache, never a Claude file', () => {
    const core = fs.readFileSync(path.join(ROOT, 'src/providers/claude-outside-core.ts'), 'utf8')
    expect(core).toMatch(/O_RDONLY/)
    expect(core).not.toMatch(/appendFile|unlink|rm\(|O_WRONLY|O_RDWR|O_CREAT/)
    // The one write is the cache beside the usage scan index.
    expect(core.match(/writeFile\(/g)?.length).toBe(1)
    expect(core).toMatch(/writeFile\(tmp, JSON\.stringify\(cache\)\)/)
  })
})

describe('plugin job caller vouching', () => {
  const standalone = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf8')
  const jobBranch = (src: string) => {
    const at = src.indexOf('if (pluginJobs.isRunSid(req.sid)) {')
    expect(at, 'the plugin job branch of handleGatewayLine').toBeGreaterThan(-1)
    return src.slice(at, src.indexOf('\n  }\n', at))
  }

  it('daemon: name the job from the run record alone; a run id no live run holds is refused', () => {
    const branch = jobBranch(standalone)
    expect(branch).toMatch(/pluginJobs\.callerOfRun\(req\.sid\)/)
    expect(branch).toContain("gatewayError('unknown_caller', 'no plugin job of this daemon runs under this id')")
  })

  it('the daemon vouches only on its check of the socket\'s process', () => {
    const own = jobBranch(standalone)
    expect(own).toMatch(/jobCallerVouched\(socketPeerPid\(fd\), pluginJobs\.runProcOf\(sid\), openedAt\)/)
    expect(own).toMatch(/seen === 'inside' \? \{ \.\.\.caller, vouched: true \} : caller/)
    // A process outside the run that holds its id still goes, unvouched: never refused for it.
    expect(own).not.toMatch(/seen === 'outside'[^\n]*unknown_caller/)
    expect(standalone.match(/vouched: true/g)).toHaveLength(1)
  })
})

describe('gateway caller identity', () => {
  const standalone = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf8')
  const body = (src: string, head: string) => {
    const at = src.indexOf(head)
    expect(at, head).toBeGreaterThan(-1)
    return src.slice(at, src.indexOf('\n}\n', at))
  }

  it('the daemon reads the socket\'s process for a session\'s sid, never for a token-proved line', () => {
    const fn = body(standalone, 'function handleGatewayLine(')
    expect(fn).toContain('if (fd === null) return sendSessionGatewayLine(req, callerSid, respond, plan)')
    expect(fn).toContain('gatewayCallerIdentity(socketPeerPid(fd), callerSid, openedAt)')
    expect(fn).toContain("sendSessionGatewayLine(req, seen === 'outside' ? EXTERNAL_CALLER_SID : callerSid, respond, plan, { fd, openedAt })")
    expect(fn).toContain("if (seen === 'unread') req.args = { ...req.args, callerUnproven: true }")
    // Its caller gone while it was read: never sent (a retry would apply a write twice).
    expect(fn).toMatch(/gatewayCallerLeft\.get\(respond\)\?\.\(\)\) return logMsg/)
    expect(body(standalone, 'async function gatewayCallerIdentity(')).toContain('claimedSidVerdict(table, peer, openedAt, procs, (pid) => now.get(pid), process.pid)')
    expect(body(standalone, 'function cmdFollowerGateway(')).toContain('handleGatewayLine(line, respond, null, openedAt)')
  })

})
