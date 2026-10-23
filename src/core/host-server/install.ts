/**
 * Installing Walnut on a host, over the Mac's SSH master
 * (docs/plan/walnut-servers-everywhere.md, "Lifecycle", "Runtime").
 *
 * A host server is the compiled walnut file (scripts/build-binary.mjs) for the
 * host's system: nothing is installed on the host first, no Node, no npm, no
 * compiler, no network.
 *
 *   ~/.open-walnut-host/
 *     app/<id>/walnut            the file for this host (fileInstallScript)
 *     app/<id>/.ready            written last: an install is all or nothing
 *     data/                      the server's own data dir (the file unpacks its runtime tree here)
 *     incoming/                  uploads, install logs, failure notes
 *
 * The cloud companion still installs the Mac's dist build with its dependencies
 * in the same layout (installScript, run by the box itself: companion-build/box.ts),
 * both by the bun the box runs on:
 *
 *     deps/<hash>/node_modules   bun install of the build's dependencies, once per set
 *     app/<id>/dist              the build; node_modules links to its deps
 *
 * The install runs detached on the host and the Mac polls its state. Everything
 * here is POSIX sh text: the scripts ride `sh -s` (remote-sh.ts).
 */

import { shq } from '../../providers/remote-sh.js'
import { validBuildId } from '../companion-build/wire.js'

export const HOST_ROOT = '$HOME/.open-walnut-host'

/**
 * A root other than HOST_ROOT (the WALNUT_HOST_SERVER_ROOT knob, tests): an
 * absolute path, or one under `$HOME`. It is put inside double quotes in the
 * scripts, so nothing that a shell expands there is taken.
 */
export function checkHostRoot(root: string): string {
  if (!/^(\$HOME)?\/[A-Za-z0-9_./-]+$/.test(root) || root.includes('..')) {
    throw new Error(`a host server root must be an absolute path (or one under $HOME) of plain characters: ${JSON.stringify(root)}`)
  }
  return root.replace(/\/+$/, '')
}
/** The cloud companion's install of a dist build (companion-build/box.ts). */
export interface InstallPlan {
  id: string
  depsHash: string
  dependencies: Record<string, string>
  appPackageJson: string
  /**
   * The bun that installs and runs the build (the box's own: bunCommand,
   * src/lib/runtime.ts). `asBun`: it is a compiled walnut file, which acts as
   * bun with BUN_BE_BUN=1.
   */
  bun: { command: string; asBun: boolean }
  /** Extra environment for the dependency install. */
  buildEnv: Record<string, string>
  /** The root on the host (default HOST_ROOT). */
  root?: string
  /** Builds the prune never removes, besides this one (the companion's current and trial). */
  keep?: string[]
  /**
   * Optional dependencies (the companion): npm then installs optional packages and
   * skips the ones this platform cannot take, instead of failing. A host passes none.
   */
  optionalDependencies?: Record<string, string>
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

function heredoc(file: string, body: string): string {
  if (body.includes('WALNUT_EOF')) throw new Error('heredoc body carries its own end marker')
  return `cat > ${file} <<'WALNUT_EOF'\n${body}\nWALNUT_EOF`
}

/** The packages whose install scripts the build's own package.json trusts (bun runs only those). */
function trustedOf(appPackageJson: string): string[] | null {
  try {
    const trusted = (JSON.parse(appPackageJson) as { trustedDependencies?: unknown }).trustedDependencies
    return Array.isArray(trusted) && trusted.every((t) => typeof t === 'string') ? trusted as string[] : null
  } catch {
    return null
  }
}

/** The script the companion box runs (detached) to install one dist build. */
export function installScript(plan: InstallPlan): string {
  for (const k of Object.keys(plan.buildEnv)) if (!ENV_KEY.test(k)) throw new Error(`build_env.${k} is not an environment variable name`)
  const keep = [...new Set(plan.keep ?? [])].filter((k) => k !== plan.id)
  for (const k of keep) if (!validBuildId(k)) throw new Error(`keep has a bad build id: ${JSON.stringify(k)}`)
  const optional = plan.optionalDependencies
  const trusted = trustedOf(plan.appPackageJson)
  const depsJson = JSON.stringify({
    name: 'open-walnut-host-deps', private: true, dependencies: plan.dependencies,
    ...(optional ? { optionalDependencies: optional } : {}),
    // bun runs a dependency's install script only when trusted: the same ones the Mac's tree trusts.
    ...(trusted ? { trustedDependencies: trusted } : {}),
  }, null, 2)
  const omit = optional ? '--production' : '--production --omit=optional'
  // An empty set (the walnut file's package, companion-build/package.ts) installs
  // nothing, so no package manager runs: a box whose server runs on Node, with no
  // bun beside it, takes it too.
  const empty = Object.keys(plan.dependencies).length === 0 && Object.keys(optional ?? {}).length === 0
  return [
    'set -u',
    `ROOT="${checkHostRoot(plan.root ?? HOST_ROOT)}"`,
    `ID=${shq(plan.id)}`,
    `DEPS=${shq(plan.depsHash)}`,
    `BUN=${shq(plan.bun.command)}`,
    // A compiled walnut file is bun only when told so; a real bun ignores the variable.
    plan.bun.asBun ? 'export BUN_BE_BUN=1' : 'unset BUN_BE_BUN',
    'APP="$ROOT/app/$ID"',
    'DEPDIR="$ROOT/deps/$DEPS"',
    'IN="$ROOT/incoming"',
    'fail() { printf "%s\\n" "$1" > "$IN/$ID.failed"; exit 1; }',
    'rm -f "$IN/$ID.failed"',
    ...Object.entries(plan.buildEnv).map(([k, v]) => `export ${k}=${shq(v)}`),
    'if [ ! -f "$DEPDIR/.ready" ]; then',
    '  rm -rf "$DEPDIR.partial" && mkdir -p "$DEPDIR.partial" || fail "cannot create $DEPDIR"',
    `  ${heredoc('"$DEPDIR.partial/package.json"', depsJson)}`,
    empty
      ? '  mkdir -p "$DEPDIR.partial/node_modules" || fail "cannot create $DEPDIR"'
      : `  (cd "$DEPDIR.partial" && "$BUN" install ${omit} --linker=hoisted --no-progress) || fail "bun install of its dependencies failed: see $IN/$ID.install.log on the host"`,
    '  rm -rf "$DEPDIR" && mv "$DEPDIR.partial" "$DEPDIR" && touch "$DEPDIR/.ready" || fail "cannot move the dependencies in place"',
    'fi',
    'rm -rf "$APP.partial" && mkdir -p "$APP.partial" || fail "cannot create $APP"',
    'tar -xzf "$IN/$ID.tgz" -C "$APP.partial" --strip-components=1 || fail "cannot unpack the build"',
    heredoc('"$APP.partial/package.json"', plan.appPackageJson),
    'ln -s "../../deps/$DEPS/node_modules" "$APP.partial/node_modules" || fail "cannot link the dependencies"',
    'mkdir -p "$ROOT/data"',
    'OPEN_WALNUT_HOME="$ROOT/data" "$BUN" "$APP.partial/dist/cli.js" --version > "$IN/$ID.version" 2>&1 || fail "the build does not start with $BUN: $(tail -n 3 "$IN/$ID.version" | tr "\\n" " ")"',
    'rm -rf "$APP" && mv "$APP.partial" "$APP" && touch "$APP/.ready" || fail "cannot move the build in place"',
    'rm -f "$IN/$ID.tgz"',
    ...pruneLines(keep),
    'echo installed',
  ].join('\n')
}

export interface FileInstallPlan {
  id: string
  /** The version `walnut --version` must print first: a file that prints another (or nothing) is not installed. */
  version: string
  /** The commit it must name after the version (`<version> (<commit>, <date>)`); null: the version alone. */
  commit: string | null
  /** sha256 of the unpacked file, checked on the host when it has sha256sum or shasum. */
  sha256: string
  /** The host in words (`Linux x86_64, glibc 2.26`), for the message when the file does not start there. */
  host: string
  /** The root on the host (default HOST_ROOT). */
  root?: string
}

const SHA256 = /^[a-f0-9]{64}$/
const VERSION_WORD = /^[0-9A-Za-z.+_-]{1,64}$/
const COMMIT_WORD = /^[0-9a-f]{4,40}$/

/**
 * The script the host runs (detached) to install the walnut file uploaded as
 * incoming/<id>.gz: unpack, check its sha256, ask its `--version` (which also
 * unpacks the file's runtime tree into the data dir, where the server finds it
 * warm), run its `__selftest` (SQLite, its worker threads, its tokenizer, the
 * daemon source: what a server boot needs and `--version` does not reach), then
 * move it in place with `.ready` last. A failure leaves a note and the uploaded
 * gz (a retry need not send it again), never a half-made app dir. It removes no
 * other build: pruneScript does, once the new server has reported.
 */
export function fileInstallScript(plan: FileInstallPlan): string {
  if (!validBuildId(plan.id)) throw new Error(`not a build id: ${JSON.stringify(plan.id)}`)
  if (!SHA256.test(plan.sha256)) throw new Error('the file\'s sha256 must be 64 hex characters')
  if (!VERSION_WORD.test(plan.version)) throw new Error(`not a version: ${JSON.stringify(plan.version)}`)
  if (plan.commit !== null && !COMMIT_WORD.test(plan.commit)) throw new Error(`not a commit: ${JSON.stringify(plan.commit)}`)
  const want = plan.commit === null
    ? 'case "$FIRST" in "$VERSION" | "$VERSION "*) ;; *) fail "the walnut file answered \\"$FIRST\\", not Walnut $VERSION" ;; esac'
    : 'case "$FIRST" in "$VERSION ($COMMIT, "* | "$VERSION ($COMMIT)") ;; *) fail "the walnut file answered \\"$FIRST\\", not Walnut $VERSION ($COMMIT)" ;; esac'
  return [
    'set -u',
    `ROOT="${checkHostRoot(plan.root ?? HOST_ROOT)}"`,
    `ID=${shq(plan.id)}`,
    `VERSION=${shq(plan.version)}`,
    `COMMIT=${shq(plan.commit ?? '')}`,
    `SHA=${shq(plan.sha256)}`,
    `HOSTDESC=${shq(plan.host)}`,
    'APP="$ROOT/app/$ID"',
    'IN="$ROOT/incoming"',
    // The note first, then the pid goes: whoever asks after this process ended reads the note.
    'trap \'rm -f "$IN/$ID.pid"\' EXIT',
    'fail() { rm -rf "$APP.partial"; printf "%s\\n" "$1" > "$IN/$ID.failed"; exit 1; }',
    'rm -f "$IN/$ID.failed"',
    'command -v gzip >/dev/null 2>&1 || fail "the host has no gzip, which unpacks the walnut file"',
    'rm -rf "$APP.partial" && mkdir -p "$APP.partial" || fail "cannot create $APP"',
    'gzip -dc "$IN/$ID.gz" > "$APP.partial/walnut" || fail "cannot unpack the walnut file (is the disk full?)"',
    'SUM=$( (sha256sum "$APP.partial/walnut" 2>/dev/null || shasum -a 256 "$APP.partial/walnut" 2>/dev/null) | awk \'{print $1}\')',
    'if [ -n "$SUM" ] && [ "$SUM" != "$SHA" ]; then fail "the walnut file arrived broken (sha256 $SUM, expected $SHA)"; fi',
    'chmod 755 "$APP.partial/walnut" || fail "cannot make the walnut file executable"',
    'mkdir -p "$ROOT/data"',
    // A file told to be bun (BUN_BE_BUN) would answer as bun. Its stderr is kept apart:
    // a warning there is no reason to refuse a file that answers right.
    'run() { (unset BUN_BE_BUN; OPEN_WALNUT_HOME="$ROOT/data" "$APP.partial/walnut" "$@"); }',
    'run --version > "$IN/$ID.version" 2> "$IN/$ID.version.err" || fail "the walnut file does not start on this host ($HOSTDESC): $(cat "$IN/$ID.version.err" "$IN/$ID.version" 2>/dev/null | tail -n 3 | tr "\\n" " ")"',
    'FIRST=$(head -n 1 "$IN/$ID.version")',
    want,
    'if ! run __selftest > "$IN/$ID.selftest" 2> "$IN/$ID.selftest.err"; then',
    '  BAD=$(grep \'"ok":false\' "$IN/$ID.selftest" | grep \'"required":true\' | head -n 3 | tr "\\n" " ")',
    '  [ -n "$BAD" ] || BAD=$(tail -n 3 "$IN/$ID.selftest.err" | tr "\\n" " ")',
    '  fail "the walnut file failed its self-check on this host ($HOSTDESC): $BAD"',
    'fi',
    'rm -rf "$APP" && mv "$APP.partial" "$APP" && touch "$APP/.ready" || fail "cannot move the walnut file in place"',
    'rm -f "$IN/$ID.gz"',
    'echo installed',
  ].join('\n')
}

/**
 * Remove the builds on the host that nothing needs: every app dir but the kept
 * ones (the server that now runs, the one that ran before it) and the newest
 * other (another Walnut sharing this root may run it); app dirs half-made an
 * hour ago; uploads and notes of other builds (an upload after an hour, the
 * rest after a day); dependency sets of the Node layout no build links to. Run
 * by the Mac once the new server has reported, never by an install.
 */
export function pruneScript(keep: string[], root: string = HOST_ROOT): string {
  const ids = [...new Set(keep)]
  for (const k of ids) if (!validBuildId(k)) throw new Error(`keep has a bad build id: ${JSON.stringify(k)}`)
  if (ids.length === 0) throw new Error('a prune keeps at least the build that runs')
  return [
    `ROOT="${checkHostRoot(root)}"`,
    `KEEP=${shq(` ${ids.join(' ')} `)}`,
    // Kept dirs are the newest: the "newest other" below is then one that is not kept.
    'for k in $KEEP; do [ -d "$ROOT/app/$k" ] && touch "$ROOT/app/$k"; done',
    'n=0; for d in $(ls -1t "$ROOT/app" 2>/dev/null | grep -v "\\.partial$"); do',
    '  case "$KEEP" in *" $d "*) continue ;; esac',
    '  n=$((n + 1)); [ "$n" -le 1 ] || rm -rf "$ROOT/app/$d"',
    'done',
    'for d in "$ROOT"/app/*.partial; do [ -d "$d" ] && [ -n "$(find "$d" -maxdepth 0 -mmin +60 2>/dev/null)" ] && rm -rf "$d"; done',
    'for f in "$ROOT"/incoming/*; do',
    '  [ -e "$f" ] || continue',
    '  b=${f##*/}; mine=no',
    '  for k in $KEEP; do case "$b" in "$k".*) mine=yes ;; esac; done',
    '  [ "$mine" = yes ] && continue',
    '  case "$b" in *.gz|*.gz.chunks-*) age=60 ;; *) age=1440 ;; esac',
    '  [ -n "$(find "$f" -maxdepth 0 -mmin +$age 2>/dev/null)" ] && rm -rf "$f"',
    'done',
    'for h in $(ls -1 "$ROOT/deps" 2>/dev/null | grep -v "\\.partial$"); do',
    '  used=no; for l in "$ROOT"/app/*/node_modules; do case "$(readlink "$l" 2>/dev/null)" in *"/deps/$h/"*) used=yes;; esac; done',
    '  [ "$used" = yes ] || rm -rf "$ROOT/deps/$h"',
    'done',
    'echo pruned',
  ].join('\n')
}

/** Keep $ID and the newest other build (and the kept ones); then the dependency sets no build links to. */
function pruneLines(keep: string[]): string[] {
  return [
    keep.length
      ? `KEEP=${shq(` ${keep.join(' ')} `)}; for d in $(ls -1t "$ROOT/app" 2>/dev/null | grep -v "^$ID$" | grep -v "\\.partial$" | tail -n +2); do case "$KEEP" in *" $d "*) ;; *) rm -rf "$ROOT/app/$d";; esac; done`
      : 'for d in $(ls -1t "$ROOT/app" 2>/dev/null | grep -v "^$ID$" | grep -v "\\.partial$" | tail -n +2); do rm -rf "$ROOT/app/$d"; done',
    'for h in $(ls -1 "$ROOT/deps" 2>/dev/null | grep -v "\\.partial$"); do',
    '  used=no; for l in "$ROOT"/app/*/node_modules; do case "$(readlink "$l" 2>/dev/null)" in *"/deps/$h/"*) used=yes;; esac; done',
    '  [ "$used" = yes ] || rm -rf "$ROOT/deps/$h"',
    'done',
  ]
}

/** Start the install script detached, its output in the install log. */
export function launchScript(id: string, root: string = HOST_ROOT): string {
  return [
    `ROOT="${checkHostRoot(root)}"`,
    `ID=${shq(id)}`,
    'IN="$ROOT/incoming"',
    // An earlier attempt's note and pid say nothing about this one.
    'rm -f "$IN/$ID.failed" "$IN/$ID.pid"',
    'nohup sh "$IN/$ID.install.sh" > "$IN/$ID.install.log" 2>&1 < /dev/null &',
    'echo $! > "$IN/$ID.pid"',
    'echo launched',
  ].join('\n')
}

export type InstallState =
  | { state: 'ready' }
  | { state: 'running' }
  | { state: 'failed'; message: string; logTail: string }
  | { state: 'absent' }

/**
 * Where an install of `id` stands on the host. The process is asked before its
 * notes: a script writes `.ready` or `.failed` and then exits, so once it is
 * gone its note is there. Asked the other way round, one that failed between
 * the two looks like it stopped without a word. A pid counts only while it is
 * the install script (its command line names `<id>.install.sh`): a pid the
 * system gave to another process since would read RUNNING forever.
 */
export function stateScript(id: string, root: string = HOST_ROOT): string {
  return [
    `ROOT="${checkHostRoot(root)}"`,
    `ID=${shq(id)}`,
    'IN="$ROOT/incoming"',
    'installing() {',
    '  P=$(cat "$IN/$ID.pid" 2>/dev/null) || return 1',
    '  [ -n "$P" ] && kill -0 "$P" 2>/dev/null || return 1',
    '  if [ -r "/proc/$P/cmdline" ]; then C=$(tr "\\000" " " < "/proc/$P/cmdline"); else C=$(ps -p "$P" -o args= 2>/dev/null) || return 0; fi',
    '  case "$C" in *"$ID.install.sh"*) return 0 ;; esac',
    '  return 1',
    '}',
    'if [ -f "$ROOT/app/$ID/.ready" ]; then echo READY',
    'elif installing; then echo RUNNING',
    'elif [ -f "$ROOT/app/$ID/.ready" ]; then echo READY',
    'elif [ -f "$IN/$ID.failed" ]; then echo FAILED; cat "$IN/$ID.failed"; echo __LOG__; tail -n 15 "$IN/$ID.install.log" 2>/dev/null',
    'else echo ABSENT; fi',
  ].join('\n')
}

export function parseInstallState(out: string): InstallState {
  const text = out.trim()
  if (text === 'READY') return { state: 'ready' }
  if (text === 'RUNNING') return { state: 'running' }
  if (text.startsWith('FAILED')) {
    const [head, log = ''] = text.slice('FAILED'.length).split('__LOG__')
    return { state: 'failed', message: head!.trim() || 'the install failed', logTail: log.trim() }
  }
  return { state: 'absent' }
}

/**
 * Which of `ports` are free on the host's loopback (each `port:free` or
 * `port:used`), asked of a JS runtime there: the installed walnut file itself,
 * as bun (`asBun`: BUN_BE_BUN=1), or the runtime a test app dir runs on.
 */
export function freePortsScript(runtime: { command: string; asBun?: boolean }, ports: number[]): string {
  const js = 'const net=require("net");(async()=>{for(const p of process.argv.slice(1).map(Number)){const free=await new Promise((r)=>{const s=net.createServer();s.once("error",()=>r(false));s.listen(p,"127.0.0.1",()=>s.close(()=>r(true)))});process.stdout.write(p+":"+(free?"free":"used")+"\\n")}})()'
  return `${runtime.asBun ? 'BUN_BE_BUN=1 ' : ''}${shq(runtime.command)} -e ${shq(js)} ${ports.map(String).join(' ')}`
}

export function parseFreePorts(out: string): Set<number> {
  const free = new Set<number>()
  for (const line of out.split('\n')) {
    const m = /^(\d+):free$/.exec(line.trim())
    if (m) free.add(Number(m[1]))
  }
  return free
}
