#!/usr/bin/env node
/**
 * The flake hunt's reporter (.github/workflows/flake-hunt.yml). The hunt reruns a
 * blocking tier on a commit CI just passed, so any failure there is a flake by
 * definition: the same code passed minutes ago. It must not turn a green commit
 * red or mail anyone, so the hunt's run stays green and this script turns what
 * the leg found into warning annotations, which the release watch reads.
 *
 *   node scripts/flake-report.mjs --label "quick 1/3" --outcome failure \
 *     --run <WALNUT_BASELINE_RUN_OUT file> --baseline tests/setup/known-failures.json
 *
 * Always exits 0. Prints nothing for a leg that passed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const FLAKY_TITLE = 'Flaky test'
export const HUNT_TITLE = 'Flake hunt'

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/**
 * What one leg found. `run` and `baseline` are test-baseline.mjs files (`failures`
 * keys, `reasons` by key), null when the file is missing or unreadable.
 */
export function flakeAnnotations({ label, outcome, run, baseline }) {
  if (outcome === 'success') return []
  if (outcome === 'skipped') {
    return [{ title: `${HUNT_TITLE} (${label})`, message: 'the leg never reached its tests (a setup step failed); read its log' }]
  }
  if (!run) {
    return [{ title: `${HUNT_TITLE} (${label})`, message: 'the leg failed without a report (a crash or a step before the tests); read its log' }]
  }
  const known = new Set(baseline?.failures ?? [])
  const fresh = (run.failures ?? []).filter((key) => !known.has(key))
  if (fresh.length === 0) {
    return [{ title: `${HUNT_TITLE} (${label})`, message: 'the leg failed with no new test failure (a file missing from the report, or too few files); read its log' }]
  }
  return fresh.map((key) => ({
    title: `${FLAKY_TITLE} (${label})`,
    message: run.reasons?.[key] ? `${key}: ${run.reasons[key]}` : key,
  }))
}

/** A workflow command line, escaped the way the Actions toolkit does. */
export function annotationLine({ title, message }) {
  const data = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  const prop = (s) => data(s).replace(/:/g, '%3A').replace(/,/g, '%2C')
  return `::warning title=${prop(title)}::${data(message)}`
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const label = arg(argv, 'label') ?? 'leg'
  const notes = flakeAnnotations({
    label,
    outcome: arg(argv, 'outcome') ?? 'failure',
    run: arg(argv, 'run') ? readJson(arg(argv, 'run')) : null,
    baseline: arg(argv, 'baseline') ? readJson(arg(argv, 'baseline')) : null,
  })
  for (const note of notes) console.log(annotationLine(note))
  if (process.env.GITHUB_STEP_SUMMARY) {
    const body = notes.length
      ? [`### ${label}: ${notes.length} finding(s)`, '', ...notes.map((n) => `- **${n.title}**: ${n.message}`), '']
      : [`### ${label}: no flake`, '']
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${body.join('\n')}\n`)
  }
}
