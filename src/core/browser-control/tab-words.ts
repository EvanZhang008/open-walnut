/**
 * Which tab a command acts on when it names none, and what an agent is told when a tab it names is
 * no longer its own (routes/browser-v1.ts). Pure.
 *
 * 2026-11-10 (a review): a subagent of a task opened its own tab and ran `close` with no tab; the
 * server's "the tab you used last" was the main agent's, so the subagent closed the main agent's
 * search page and answered "ok". Executors of one task share its session, so the server cannot
 * tell them apart: a command with no tab now acts only when the task holds exactly one tab, and
 * with two or more it is refused with the task's tabs listed.
 */
import type { TabEndWhy } from './hub.js'

/** A tab of the task, as the refusal lists it. */
export interface TaskTab { tab: number; title?: string; url?: string }

/** How an agent tab ended (hub.ts TabEndWhy), and whose it was. */
export interface TabEnd { owner: string; why: TabEndWhy }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** An address as a line has room for: host and path, no scheme, no query. */
export function shortUrl(url: string | undefined): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    return clip(`${u.host}${u.pathname === '/' ? '' : u.pathname}`, 70)
  } catch { return clip(url, 70) }
}

/**
 * The tab a command with no tab acts on: the task's only tab. Undefined with none or several
 * (whichTabWords says which), never a guess such as the tab used last.
 */
export function defaultTab(tabs: readonly number[]): number | undefined {
  return tabs.length === 1 ? tabs[0] : undefined
}

/** The refusal of a command that names no tab while the task holds several: each tab on a line. */
export function whichTabWords(tabs: readonly TaskTab[]): string {
  const lines = tabs.slice(0, 10).map((t) => `  ${t.tab}  ${clip((t.title ?? '').replace(/\s+/g, ' ').trim(), 60)}  ${shortUrl(t.url)}`.trimEnd())
  const more = tabs.length > 10 ? [`  … and ${tabs.length - 10} more (tabs lists them)`] : []
  return [
    `This task has ${tabs.length} tabs, so name the one to act on: pass --tab <id> (the op's tab). `
      + 'Subagents of one task share its tabs: each names its own.',
    ...lines, ...more,
  ].join('\n')
}

/** Why a tab the agent named is not its own now, from how it ended (none known: the general words). */
export function notYourTabWords(tab: number, end: TabEnd | undefined, owner: string): string {
  const next = 'tabs lists yours, open <url> starts a new one.'
  if (!end || end.owner !== owner) return `That tab is not one an agent opened (or the person took it back with Stop): ${next}`
  switch (end.why) {
    case 'closed': case 'given_back':
      return `This task closed tab ${tab} earlier (a close by this agent or another of the task, a subagent's say): ${next}`
    case 'stopped': return `The person took tab ${tab} back with Stop: ${next}`
    case 'tidied': return `Walnut closed tab ${tab} after it went unused: ${next}`
    case 'browser_left': return `The browser that held tab ${tab} left Walnut: ${next}`
    case 'gone': return `Tab ${tab} was closed in the browser (by the person or the page): ${next}`
  }
}
