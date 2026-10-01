/**
 * The one-line build identity at the bottom of Settings, e.g.
 * `Open Walnut 0.4.5 · commit 3942cf7 · built 2026-09-24`. package.json only
 * moves on npm releases, so the commit is what tells a source checkout of main
 * from the last npm install in a support thread.
 */
import type { BuildInfo } from '@/api/config'
import type { UpdateStatus } from '@/api/update'

/** Local calendar date (YYYY-MM-DD) of an ISO time, or null. */
export function buildDate(builtAt: string | null): string | null {
  if (!builtAt) return null
  const d = new Date(builtAt)
  if (Number.isNaN(d.getTime())) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function formatBuildLine(info: BuildInfo): string {
  const parts = [`Open Walnut ${info.version}`]
  if (info.commit) parts.push(`commit ${info.commit}${info.dirty ? '+dirty' : ''}`)
  const date = buildDate(info.builtAt)
  if (date) parts.push(`built ${date}`)
  return parts.join(' · ')
}

/** Hover detail the line leaves out: branch and exact build time. */
export function buildLineTitle(info: BuildInfo): string | undefined {
  const parts: string[] = []
  if (info.branch) parts.push(`Branch ${info.branch}`)
  if (info.builtAt) parts.push(`built ${info.builtAt}`)
  if (info.dirty) parts.push('uncommitted changes')
  return parts.length ? parts.join(' · ') : undefined
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
