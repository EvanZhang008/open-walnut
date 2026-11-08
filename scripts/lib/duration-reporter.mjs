/**
 * A vitest reporter that writes each test file's whole cost: preparing the worker, loading the
 * environment, importing the setup files, collecting (importing the file and everything it
 * imports) and running its tests. The JSON reporter's start and end times cover only the tests
 * themselves, so a file with a slow import and a quick assertion read as 2 ms there.
 * Output: { "<repo-relative file>": ms } at $WALNUT_DURATIONS_OUT.
 */
import fs from 'node:fs'
import path from 'node:path'

export function fileCost(file) {
  return Math.round((file.prepareDuration ?? 0) + (file.environmentLoad ?? 0) + (file.setupDuration ?? 0) + (file.collectDuration ?? 0) + (file.result?.duration ?? 0))
}

export default class DurationReporter {
  onInit(ctx) { this.root = ctx.config.root }
  onFinished(files = []) {
    const out = process.env.WALNUT_DURATIONS_OUT
    if (!out) return
    const costs = {}
    for (const f of files) costs[path.relative(this.root ?? process.cwd(), f.filepath)] = fileCost(f)
    fs.writeFileSync(out, JSON.stringify(costs))
  }
}
