/**
 * A vitest reporter that says how many test files the run selected, once the
 * selection is made and before the first file runs. scripts/test-changed.mjs adds
 * it to every tier (next to the default reporter), so each tier's count is printed
 * up front and a narrowed tier that selected nothing is told apart from a pass.
 *
 * WALNUT_SELECTION_LABEL names the tier in the line; WALNUT_SELECTION_FILE, when
 * set, receives the bare count.
 */
import fs from 'node:fs'

export default class SelectionReporter {
  onTestRunStart(specifications) {
    const count = new Set(specifications.map((s) => s.moduleId)).size
    const label = process.env.WALNUT_SELECTION_LABEL || 'vitest'
    process.stdout.write(`\n[${label}] ${count} test file${count === 1 ? '' : 's'} selected\n\n`)
    const out = process.env.WALNUT_SELECTION_FILE
    if (out) fs.writeFileSync(out, `${count}\n`)
  }
}
