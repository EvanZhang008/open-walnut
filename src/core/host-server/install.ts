/**
 * Installing a host server's build on the host, over the Mac's SSH master
 * (docs/plan/walnut-servers-everywhere.md, "Lifecycle", "Runtime").
 *
 *   ~/.open-walnut-host/
 *     deps/<hash>/node_modules   npm install of the build's dependencies, once per set
 *     app/<id>/dist              the build; node_modules links to its deps
 *     app/<id>/.ready            written last: an install is all or nothing
 *     data/                      the server's own data dir
 *     incoming/                  uploads, install logs, failure notes
 *
 * The install runs detached on the host (a dependency install can take minutes:
 * a native module may compile there), and the Mac polls its state. Everything
 * here is POSIX sh text: the scripts ride `sh -s` (remote-sh.ts).
 */

import { shq } from '../../providers/remote-sh.js'

export const HOST_ROOT = '$HOME/.open-walnut-host'
/** The oldest Node a host server runs on (package.json engines). */
export const MIN_NODE_MAJOR = 22

export interface InstallPlan {
  id: string
  depsHash: string
  dependencies: Record<string, string>
  appPackageJson: string
  /** Absolute path of a Node that runs on the host. */
  node: string
  /** Extra environment for the dependency install (CC, CXX for a native module). */
  buildEnv: Record<string, string>
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

function heredoc(file: string, body: string): string {
  if (body.includes('WALNUT_EOF')) throw new Error('heredoc body carries its own end marker')
  return `cat > ${file} <<'WALNUT_EOF'\n${body}\nWALNUT_EOF`
}

/** The script the host runs (detached) to install one build. */
export function installScript(plan: InstallPlan): string {
  for (const k of Object.keys(plan.buildEnv)) if (!ENV_KEY.test(k)) throw new Error(`build_env.${k} is not an environment variable name`)
  const depsJson = JSON.stringify({ name: 'open-walnut-host-deps', private: true, dependencies: plan.dependencies }, null, 2)
  return [
    'set -u',
    `ROOT="${HOST_ROOT}"`,
    `ID=${shq(plan.id)}`,
    `DEPS=${shq(plan.depsHash)}`,
    `NODE=${shq(plan.node)}`,
    'APP="$ROOT/app/$ID"',
    'DEPDIR="$ROOT/deps/$DEPS"',
    'IN="$ROOT/incoming"',
    'fail() { printf "%s\\n" "$1" > "$IN/$ID.failed"; exit 1; }',
    'rm -f "$IN/$ID.failed"',
    'NODE_DIR=$(dirname "$NODE")',
    'export PATH="$NODE_DIR:$PATH"',
    'NPM="$NODE_DIR/npm"; [ -x "$NPM" ] || NPM=npm',
    // A newer compiler for native modules: the settings first, else a gcc10 an
    // older Linux ships next to its default gcc.
    ...Object.entries(plan.buildEnv).map(([k, v]) => `export ${k}=${shq(v)}`),
    ...(plan.buildEnv.CC || plan.buildEnv.CXX ? [] : [
      'if command -v gcc10-cc >/dev/null 2>&1 && command -v gcc10-c++ >/dev/null 2>&1; then export CC=gcc10-cc CXX=gcc10-c++; fi',
    ]),
    'if [ ! -f "$DEPDIR/.ready" ]; then',
    '  rm -rf "$DEPDIR.partial" && mkdir -p "$DEPDIR.partial" || fail "cannot create $DEPDIR"',
    `  ${heredoc('"$DEPDIR.partial/package.json"', depsJson)}`,
    '  (cd "$DEPDIR.partial" && "$NPM" install --no-audit --no-fund --omit=optional --omit=dev --loglevel=error) || fail "npm install of its dependencies failed: see $IN/$ID.install.log on the host"',
    '  rm -rf "$DEPDIR" && mv "$DEPDIR.partial" "$DEPDIR" && touch "$DEPDIR/.ready" || fail "cannot move the dependencies in place"',
    'fi',
    'rm -rf "$APP.partial" && mkdir -p "$APP.partial" || fail "cannot create $APP"',
    'tar -xzf "$IN/$ID.tgz" -C "$APP.partial" --strip-components=1 || fail "cannot unpack the build"',
    heredoc('"$APP.partial/package.json"', plan.appPackageJson),
    'ln -s "../../deps/$DEPS/node_modules" "$APP.partial/node_modules" || fail "cannot link the dependencies"',
    'mkdir -p "$ROOT/data"',
    'OPEN_WALNUT_HOME="$ROOT/data" "$NODE" "$APP.partial/dist/cli.js" --version > "$IN/$ID.version" 2>&1 || fail "the build does not start with $NODE: $(tail -n 3 "$IN/$ID.version" | tr "\\n" " ")"',
    'rm -rf "$APP" && mv "$APP.partial" "$APP" && touch "$APP/.ready" || fail "cannot move the build in place"',
    'rm -f "$IN/$ID.tgz"',
    // Keep this build and the newest other one; then the dependency sets no build links to.
    'for d in $(ls -1t "$ROOT/app" 2>/dev/null | grep -v "^$ID$" | grep -v "\\.partial$" | tail -n +2); do rm -rf "$ROOT/app/$d"; done',
    'for h in $(ls -1 "$ROOT/deps" 2>/dev/null | grep -v "\\.partial$"); do',
    '  used=no; for l in "$ROOT"/app/*/node_modules; do case "$(readlink "$l" 2>/dev/null)" in *"/deps/$h/"*) used=yes;; esac; done',
    '  [ "$used" = yes ] || rm -rf "$ROOT/deps/$h"',
    'done',
    'echo installed',
  ].join('\n')
}

/** Start the install script detached, its output in the install log. */
export function launchScript(id: string): string {
  return [
    `ROOT="${HOST_ROOT}"`,
    `ID=${shq(id)}`,
    'IN="$ROOT/incoming"',
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

/** Where an install of `id` stands on the host. */
export function stateScript(id: string): string {
  return [
    `ROOT="${HOST_ROOT}"`,
    `ID=${shq(id)}`,
    'IN="$ROOT/incoming"',
    'if [ -f "$ROOT/app/$ID/.ready" ]; then echo READY',
    'elif [ -f "$IN/$ID.failed" ]; then echo FAILED; cat "$IN/$ID.failed"; echo __LOG__; tail -n 15 "$IN/$ID.install.log" 2>/dev/null',
    'elif [ -f "$IN/$ID.pid" ] && kill -0 "$(cat "$IN/$ID.pid")" 2>/dev/null; then echo RUNNING',
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

/** Whether `node` runs on the host and is new enough: prints its version, or why not. */
export function nodeCheckScript(node: string): string {
  return `${shq(node)} -v 2>&1 | head -n 1`
}

export function nodeMajor(versionLine: string): number | null {
  const m = /^v(\d+)\./.exec(versionLine.trim())
  return m ? Number(m[1]) : null
}

/** Which of `ports` are free on the host's loopback (each `port:free` or `port:used`). */
export function freePortsScript(node: string, ports: number[]): string {
  const js = 'const net=require("net");(async()=>{for(const p of process.argv.slice(1).map(Number)){const free=await new Promise((r)=>{const s=net.createServer();s.once("error",()=>r(false));s.listen(p,"127.0.0.1",()=>s.close(()=>r(true)))});process.stdout.write(p+":"+(free?"free":"used")+"\\n")}})()'
  return `${shq(node)} -e ${shq(js)} ${ports.map(String).join(' ')}`
}

export function parseFreePorts(out: string): Set<number> {
  const free = new Set<number>()
  for (const line of out.split('\n')) {
    const m = /^(\d+):free$/.exec(line.trim())
    if (m) free.add(Number(m[1]))
  }
  return free
}
