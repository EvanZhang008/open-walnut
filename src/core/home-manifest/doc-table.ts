/**
 * The tables of docs/reference/data-locations.md, rendered from the manifest. The doc
 * keeps them between markers; tests/core/home-manifest/data-locations-doc.test.ts fails
 * when they drift and rewrites them with WALNUT_WRITE_DATA_LOCATIONS=1.
 */
import { homeEntries, outsideHomeEntries } from './index.js'
import type { DataEntry, OutsideEntry, OutsideRoot } from './types.js'

export const DOC_TABLE_START = '<!-- data-locations:start (generated from src/core/home-manifest; do not edit by hand) -->'
export const DOC_TABLE_END = '<!-- data-locations:end -->'

const ROOT_LABEL: Record<OutsideRoot, string> = {
  'xdg-state': '$XDG_STATE_HOME',
  'xdg-data': '~/.local/share',
  'claude-home': '~/.claude',
  'daemon-dir': '<runtime dir>',
  'user-home': '~',
}

const cell = (s: string) => s.replace(/\|/g, '\\|')

function where(base: string, entry: DataEntry): string {
  const shown = entry.path ? `${base}/${entry.path}${entry.kind === 'dir' ? '/' : ''}` : `${base}/`
  const pattern = entry.match ? ` (and names matching \`${cell(entry.match.source)}\`)` : ''
  return `\`${cell(shown)}\`${pattern}`
}

function row(base: string, entry: DataEntry): string {
  const cls = 'daemonState' in entry && entry.daemonState ? `${entry.class} (daemon state)` : entry.class
  return `| ${where(base, entry)} | ${cls} | ${entry.sensitive ? 'yes' : 'no'} | ${cell(entry.what)} |`
}

const HEADER = ['| Where | Class | Sensitive | What |', '| --- | --- | --- | --- |']

/** The entries the doc shows: every one but the places only older releases wrote (no doc names those). */
export function documentedEntries(): DataEntry[] {
  return [...homeEntries(), ...outsideHomeEntries()].filter((e) => !e.legacy)
}

/** The generated block, markers included. */
export function renderDataLocationsBlock(): string {
  const shown = documentedEntries()
  const home = shown.filter((e) => !('root' in e)).map((e) => row('~/.open-walnut', e))
  const outside = shown.filter((e): e is OutsideEntry => 'root' in e).map((e) => row(ROOT_LABEL[e.root], e))
  return [
    DOC_TABLE_START,
    '',
    '### In the data home (`~/.open-walnut`, or `OPEN_WALNUT_HOME`)',
    '',
    ...HEADER, ...home,
    '',
    '### Outside the data home',
    '',
    ...HEADER, ...outside,
    '',
    DOC_TABLE_END,
  ].join('\n')
}
