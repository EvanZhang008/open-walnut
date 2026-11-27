/**
 * The one-line build identity at the bottom of Settings, e.g.
 * `Open Walnut 0.4.5, commit 3942cf7, built Sep 24` (commas, so a copied line reads the
 * same and the pane stays glyph free, C8). package.json only moves on npm releases, so the
 * commit is what tells a source checkout of main from the last npm install in a support thread.
 */
import type { BuildInfo } from '@/api/config'
import type { UpdateStatus } from '@/api/update'
import { dayDate, fullTime, type TimeWordsOptions } from '@/utils/time'

export function formatBuildLine(info: BuildInfo, opts?: TimeWordsOptions): string {
  const parts = [`Open Walnut ${info.version}`]
  if (info.commit) parts.push(`commit ${info.commit}${info.dirty ? '+dirty' : ''}`)
  const date = dayDate(info.builtAt, opts)
  if (date) parts.push(`built ${date}`)
  return parts.join(', ')
}

/** Hover detail the line leaves out: branch and the whole build time. */
export function buildLineTitle(info: BuildInfo): string | undefined {
  const parts: string[] = []
  if (info.branch) parts.push(`Branch ${info.branch}`)
  const built = fullTime(info.builtAt)
  if (built) parts.push(`built ${built}`)
  if (info.dirty) parts.push('uncommitted changes')
  return parts.length ? parts.join(', ') : undefined
}

/**
 * The update segment of the line: `0.6.0 available` with the install command as
 * the hover title, or null when there is nothing newer (or no check runs here).
 */
export function formatUpdateSegment(status: UpdateStatus | null): { text: string; title: string } | null {
  if (!status || !status.enabled || !status.available || !status.latest) return null
  return {
    text: `${status.latest} available`,
    title: status.install.updateCommand
      ? `Update with: ${status.install.updateCommand}`
      : `A newer Open Walnut is published: ${status.packageUrl}`,
  }
}
