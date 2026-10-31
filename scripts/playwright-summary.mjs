#!/usr/bin/env bun
/**
 * A Playwright JSON report (`--reporter=json`) as a short markdown summary for a
 * CI step summary: the totals, then each failing and each flaky test by file and
 * title (the same `file :: title` keys a known-failures baseline would hold),
 * led by any error outside a test (a spec that failed to load).
 *
 *   node scripts/playwright-summary.mjs <report.json> [--keys]
 *
 * `--keys` prints only the failing keys, one per line, sorted.
 */
import fs from 'node:fs'

/** The first line of a failed test's last error, without terminal colours. */
function errorLine(test) {
  const last = test.results?.[test.results.length - 1]
  const message = last?.error?.message ?? last?.errors?.[0]?.message
  if (!message) return undefined
  return String(message).replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 300)
}

/**
 * Every test in the report as { key, status } ('expected' | 'unexpected' | 'flaky' | 'skipped'),
 * plus `error` (its last error's first line) on a failed one that has results, and
 * `interrupted` when a run of it was cut off (the run's --global-timeout).
 *
 * The key's file is the spec file Playwright ran (the top-level suite), not the
 * file the test() call sits in: a helper shared by a `.spec.ts` and a
 * `.webkit.spec.ts` (stt-failure-helpers.ts) defines tests for both, and keyed by
 * the helper the two had one key, so one's failure was hidden by the other's pass.
 */
export function testsOf(report) {
  const out = []
  const walk = (suite, titles, root) => {
    const here = suite.title && !suite.title.endsWith('.ts') ? [...titles, suite.title] : titles
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const row = { key: `${root ?? spec.file} :: ${[...here, spec.title].join(' › ')}`, status: t.status }
        const error = t.status === 'unexpected' ? errorLine(t) : undefined
        if (error) row.error = error
        if ((t.results ?? []).some((r) => r.status === 'interrupted')) row.interrupted = true
        out.push(row)
      }
    }
    for (const child of suite.suites ?? []) walk(child, here, root)
  }
  for (const s of report.suites ?? []) walk(s, [], s.file)
  return out
}

export function summarize(report) {
  const tests = testsOf(report)
  const by = (s) => tests.filter((t) => t.status === s).map((t) => t.key).sort()
  const failed = by('unexpected')
  const flaky = by('flaky')
  const lines = [
    `**${tests.length} tests:** ${by('expected').length} passed, ${failed.length} failed, ${flaky.length} flaky (passed on a retry), ${by('skipped').length} skipped`,
  ]
  // Errors outside any test: a spec that fails to load stops the whole run.
  // Playwright gives these no location, and one bad import repeats per spec that has it.
  const errors = new Map()
  for (const e of report.errors ?? []) {
    const m = String(e.message ?? e.value ?? e).split('\n')[0].slice(0, 300)
    errors.set(m, (errors.get(m) ?? 0) + 1)
  }
  if (errors.size) lines.unshift('**The suite did not run cleanly:**', '', ...[...errors].map(([m, n]) => `- ${m}${n > 1 ? ` (×${n})` : ''}`), '')
  if (failed.length) lines.push('', '<details><summary>Failed</summary>', '', ...failed.map((k) => `- \`${k}\``), '', '</details>')
  if (flaky.length) lines.push('', '<details><summary>Flaky</summary>', '', ...flaky.map((k) => `- \`${k}\``), '', '</details>')
  return `${lines.join('\n')}\n`
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  const file = process.argv[2]
  if (!file) {
    process.stderr.write('usage: playwright-summary.mjs <report.json> [--keys]\n')
    process.exit(2)
  }
  const report = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (process.argv.includes('--keys')) {
    const keys = testsOf(report).filter((t) => t.status === 'unexpected').map((t) => t.key).sort()
    process.stdout.write(keys.length ? `${keys.join('\n')}\n` : '')
  } else {
    process.stdout.write(summarize(report))
  }
}
