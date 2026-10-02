#!/usr/bin/env node
/**
 * A Playwright JSON report (`--reporter=json`) as a short markdown summary for a
 * CI step summary: the totals, then each failing and each flaky test by file and
 * title (the same `file :: title` keys a known-failures baseline would hold).
 *
 *   node scripts/playwright-summary.mjs <report.json> [--keys]
 *
 * `--keys` prints only the failing keys, one per line, sorted.
 */
import fs from 'node:fs'

/** Every test in the report as { key, status } ('expected' | 'unexpected' | 'flaky' | 'skipped'). */
export function testsOf(report) {
  const out = []
  const walk = (suite, titles) => {
    const here = suite.title && !suite.title.endsWith('.ts') ? [...titles, suite.title] : titles
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        out.push({ key: `${spec.file ?? suite.file} :: ${[...here, spec.title].join(' › ')}`, status: t.status })
      }
    }
    for (const child of suite.suites ?? []) walk(child, here)
  }
  for (const s of report.suites ?? []) walk(s, [])
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
