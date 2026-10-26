/**
 * A dense, realistic board for the related-open-tasks ranking: 130 open tasks in ONE
 * project ("marina"), built the way a busy mobile project's board reads. Every title
 * leans on the same few words ("Fix", "iOS", "test"), components repeat across five
 * aspects each, and a third of the rows carry a short brief. Neutral names only.
 */
import type { RankableTask } from '../../../src/core/sessions/related-open-rank.js'

const COMPONENTS = [
  'keyboard', 'share sheet', 'drawer', 'push token', 'offline drain', 'calendar popover',
  'voice input', 'inbox thread', 'board chip', 'folder rename', 'login screen', 'widget',
  'photo picker', 'search bar', 'settings pane', 'deep link', 'badge count', 'dark mode',
  'tab bar', 'pull to refresh', 'session list', 'reply composer', 'task card', 'sync banner',
  'onboarding page', 'notification sound',
]
const ASPECTS = ['layout', 'crash', 'scroll jump', 'flaky test', 'slow first load']
const PREFIXES = ['Fix iOS', 'iOS:', 'Test', 'Fix', 'iOS test flake in']

export interface FixtureTask extends RankableTask { phase: string }

export function denseBoard(): FixtureTask[] {
  const out: FixtureTask[] = []
  let n = 0
  for (const c of COMPONENTS) {
    for (const a of ASPECTS) {
      const prefix = PREFIXES[n % PREFIXES.length]
      const brief = n % 3 === 0 ? `Repro on iOS 18. Steps: open the ${c}, then check the ${a}. Add a test.` : ''
      out.push({
        id: `t-${String(n).padStart(3, '0')}`,
        title: `${prefix} ${c} ${a}`,
        description: brief,
        project: 'marina',
        group_id: n % 4 === 0 ? 'g_mobile' : undefined,
        phase: n % 7 === 0 ? 'WAITING' : 'IN_PROGRESS',
      })
      n++
    }
  }
  return out
}

/**
 * A bilingual product board shaped like a real one (2026-10-26 copy, renamed): titles
 * with a " (middle dot) Suffix" layer, CJK and mixed titles, sibling team tasks, a fork, and lead
 * briefs that share a standard paragraph. The regression pairs in the ranking test
 * run against it.
 */
export const LEAD_BOILERPLATE = 'Test resources: heavy tests and builds run on the build box; WebKit, the phone simulator and Mac App signing stay local. '
  + 'Work place: open your own working copy in a durable directory, and send the lead one line when it is ready to land.'

export function productBoard(): FixtureTask[] {
  const rows: Array<[string, string?]> = [
    ['Compact failure and history errors \u00b7 Rule Cleanup'],
    ['\u6bcf\u65e5\u6458\u8981 \u00b7 Daily Digest'],
    ['Session message queue stall'],
    ['Growth: demo clips', 'Short clips of the board for the launch post.'],
    ['Growth: trend scout', 'Find threads where people ask for this; hand them to listings and community voice.'],
    ['Growth: community voice', 'Answer in the threads the trend scout finds.'],
    ['Growth: listings', 'Submit the app to directories; the trend scout lists where.'],
    ['\u63d2\u4ef6\u8fb9\u5efa\u8fb9\u51fa\u73b0\u5728\u4fa7\u680f', LEAD_BOILERPLATE],
    ['\u91cd\u542f\u540e\u81ea\u52a8\u6062\u590d\u88ab\u6253\u65ad\u4efb\u52a1', LEAD_BOILERPLATE],
    ['\u6536\u4ef6\u7bb1\u957f\u5bf9\u8bdd\u6eda\u4e0d\u5230\u5e95\uff1a\u7ebf\u7a0b\u72ec\u7acb\u6eda\u52a8\uff0c\u9ed8\u8ba4\u505c\u5728\u6700\u65b0', LEAD_BOILERPLATE],
    ['host \u767b\u5f55\u8fc7\u671f\u65f6\u63d0\u9192\u7528\u6237\u4e00\u6b21', LEAD_BOILERPLATE],
    ['Remind the user once when a host login expires'],
    ['App npm update notification design \u00b7 Mac App'],
    ['\u72b6\u6001\u548c Board \u91cd\u65b0\u8bbe\u8ba1\uff1a\u8ba9\u7528\u6237\u4e00\u773c\u770b\u61c2'],
    ['Routine: Weekly and monthly LLM cost'],
    ['Practice round: rotting oranges'],
    ['Shop chat channel catch-up \u00b7 Weekly'],
    ['Session tree pin rework \u00b7 Rider Bubble'],
    ['Remote access mode \u00b7 Guided Setup'],
    ['iOS \u804a\u5929\u6d88\u606f\u6392\u5e8f\u9519\u4e71'],
    ['iOS \u5411\u4e0b\u6eda\u52a8\u5361\u4f4f \u00b7 Process Safety'],
    ['Slack and mail console plugins \u00b7 Chat'],
    ['\u624b\u673a MP4 \u6253\u4e0d\u5f00'],
    ['Board \u6807\u7b7e\u3001\u83dc\u5355\u4e0e\u6458\u8981\u6761\u964d\u566a \u00b7 Time Pill', LEAD_BOILERPLATE],
    ['Phone voice input fails while the Mac sleeps'],
  ]
  return rows.map(([title, description], i) => ({
    id: `p-${String(i).padStart(2, '0')}`, title, description: description ?? '', project: 'app', phase: 'IN_PROGRESS',
  }))
}
