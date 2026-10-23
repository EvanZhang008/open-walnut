/**
 * scripts/dev-prod.sh must never boot the server from the repo's dist path.
 *
 * 2026-08-27: four consecutive deploys failed their readiness window and rolled
 * back to LKG — a byte-identical cli.js booted in ~1s from the LKG copy on the
 * temp volume but produced zero log lines for 6+ minutes when launched from the
 * repo path under the user's home. On-access endpoint scanners hold the first
 * open of freshly written files, and a deploy always boots a freshly built dist
 * at the exact moment the machine is busiest. The temp volume is outside the
 * scan scope, so every boot (smoke AND prod) must run from a staged copy there.
 *
 * Static ratchets on the script text — the class of regression is "someone adds
 * or restores a boot that points at $REPO_ROOT/dist/cli.js".
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'dev-prod.sh')
const script = fs.readFileSync(SCRIPT, 'utf-8')

describe('dev-prod staged boot', () => {
  it('never boots from the repo dist or dist-bin path (scanner-stall class)', () => {
    // Copying $REPO_ROOT/dist or dist-bin (staging, snapshots) and *matching* the
    // path in the stray-zombie sweep are fine — only EXECUTING from it is the
    // regression. Boot sites are launch_server calls, the server argv, the
    // selftest and direct $NODE_BIN runs.
    expect(script).not.toMatch(/launch_server "\$REPO_ROOT/)
    expect(script).not.toMatch(/launch_server \w+ "\$REPO_ROOT/)
    expect(script).not.toMatch(/"\$NODE_BIN" "\$REPO_ROOT\/dist\/cli\.js"/)
    expect(script).not.toMatch(/^\s*"\$REPO_ROOT\/dist-bin\/walnut-[^"]*"\s+(web|__selftest)/m)
  })

  it('stages the build on the temp volume and boots from the stage', () => {
    expect(script).toContain('open-walnut-stage.')
    expect(script).toMatch(/CLI_JS="\$STAGE_DIR\/dist\/cli\.js"/)
    expect(script).toMatch(/SERVER_FILE="\$STAGE_DIR\/dist-bin\/walnut-\$SELF_TARGET"/)
    // The files are copied from the build into the stage, never run in place.
    expect(script).toMatch(/clone_copy "\$src" "\$STAGE_DIR\/dist-bin\/walnut-\$t"/)
    // Every boot rides the staged path: the server, the smoke boot, the selftest.
    expect(script).toMatch(/launch_server "\$SERVER_KIND" "\$SERVER_PATH"/)
    expect(script).toMatch(/SERVER_PATH="\$SERVER_FILE"/)
    expect(script).toMatch(/SERVER_PATH="\$CLI_JS"/)
    expect(script).toMatch(/smoke_argv=\(WALNUT_RUNTIME_DIR="\$SMOKE_TMP\/runtime" "\$SERVER_FILE"\)/)
    expect(script).toMatch(/smoke_argv=\("\$NODE_BIN" "\$CLI_JS"\)/)
    expect(script).toMatch(/"\$\{smoke_argv\[@\]\}" web --port "\$smoke_port"/)
    expect(script).toMatch(/"\$SERVER_FILE" __selftest/)
    // The file's runtime tree is unpacked into the stage, not the data home.
    expect(script).toMatch(/WALNUT_RUNTIME_DIR="\$STAGE_DIR\/runtime"/)
  })

  it('staging failure aborts BEFORE the old server is killed', () => {
    const stageAbort = script.indexOf('deploy aborted, prod untouched')
    const killStep = script.indexOf('kill -15 $existing_pids')
    expect(stageAbort).toBeGreaterThan(-1)
    expect(killStep).toBeGreaterThan(-1)
    expect(stageAbort).toBeLessThan(killStep)
  })

  it('old stages are swept only after every prior server is dead', () => {
    const sweep = script.indexOf('open-walnut-stage.*')
    const killStep = script.indexOf('kill -15 $existing_pids')
    expect(sweep).toBeGreaterThan(killStep)
  })

  it('judges a zero-output candidate in seconds, not the whole readiness window', () => {
    expect(script).toContain('FIRSTLOG_SECS')
    expect(script).toMatch(/WALNUT_DEVPROD_FIRSTLOG_SECS/)
    // The fast-fail must roll back, not just exit.
    const firstlogBlock = script.slice(script.indexOf('elapsed_halves == FIRSTLOG_SECS'))
    const rollbackAt = firstlogBlock.indexOf('rollback_to_lkg')
    expect(rollbackAt).toBeGreaterThan(-1)
    expect(rollbackAt).toBeLessThan(firstlogBlock.indexOf('sleep 0.5'))
  })

  it('LKG snapshot is taken from the stage (byte-identical, scanner-exempt)', () => {
    expect(script).toMatch(/cp -Rc "\$STAGE_DIR\/dist" "\$LKG_DIR\.tmp\/dist"/)
    // The compiled file: its dist-bin (siblings included) and the tree it unpacked.
    expect(script).toMatch(/clone_copy "\$STAGE_DIR\/dist-bin" "\$LKG_DIR\.tmp\/dist-bin"/)
    expect(script).toMatch(/clone_copy "\$STAGE_DIR\/runtime" "\$LKG_DIR\.tmp\/runtime"/)
  })
})
