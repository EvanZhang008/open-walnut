#!/usr/bin/env bun
/**
 * Rollback helper for the simple mail flow (src/core/router/simplify-migration.ts): puts back
 * every area mark, area membership, restricted item, rule binding and receiver session profile
 * the boot migration moved, from `~/.open-walnut/router/simplify-backups.json`.
 *
 * Only for a rollback to a build older than the simple flow:
 *   1. stop the Walnut server;
 *   2. bun scripts/router-simplify-restore.ts          # preview: what each run would put back
 *      bun scripts/router-simplify-restore.ts --live   # put it back
 *   3. start the older build (this build would move it all again at its next boot).
 *
 * Each run is restored once; running it again restores nothing.
 */
import { readJsonFile } from '../src/utils/fs.js'
import { WALNUT_HOME } from '../src/constants.js'
import { restoreRouterSimplify, routerSimplifyBackupsPath, type RouterSimplifyRun } from '../src/core/router/simplify-migration.js'

const live = process.argv.includes('--live')
const runs = await readJsonFile<RouterSimplifyRun[]>(routerSimplifyBackupsPath(WALNUT_HOME), [])
const due = runs.filter((run) => !run.restoredAt)
for (const run of due) {
  console.log(`${run.at}: ${run.members.reduce((n, one) => n + one.taskIds.length, 0)} memberships, ${run.marks.length} task marks, `
    + `${run.items.length} restricted items, ${run.ruleBindings.length} rule bindings, ${run.profiles.length} session profiles`)
}
if (!due.length) console.log('Nothing to restore.')
else if (!live) console.log('Preview only: run again with --live to put these back.')
else console.log(`Restored ${await restoreRouterSimplify()} run(s).`)
