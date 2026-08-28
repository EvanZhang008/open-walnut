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
  it('never boots node from the repo dist path (scanner-stall class)', () => {
    // Copying $REPO_ROOT/dist (staging, snapshots) and *matching* the path in
    // the stray-zombie sweep are fine — only EXECUTING from it is the
    // regression. Boot sites are launch_server calls and direct $NODE_BIN runs.
    expect(script).not.toMatch(/launch_server "\$REPO_ROOT/)
    expect(script).not.toMatch(/"\$NODE_BIN" "\$REPO_ROOT\/dist\/cli\.js"/)
  })

  it('stages the dist on the temp volume and boots from the stage', () => {
    expect(script).toContain('open-walnut-stage.')
    expect(script).toMatch(/CLI_JS="\$STAGE_DIR\/dist\/cli\.js"/)
    // Both boots ride the staged path.
    expect(script).toMatch(/launch_server "\$CLI_JS"/)
    expect(script).toMatch(/"\$NODE_BIN" "\$CLI_JS" web --port "\$smoke_port"/)
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
  })
})
