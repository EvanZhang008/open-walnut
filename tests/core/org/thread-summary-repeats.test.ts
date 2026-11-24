/**
 * A summary that says his own message back to him is refused (2026-11-23, the user, on a card that
 * opened with his voice message quoted: "it repeats my question completely ... summarize it, or just
 * say the matter"). src/core/org/thread-summary-content.ts summaryRepeatsHim.
 *
 * The rule's edges: a run of 70 of his characters (20 when his message is mostly CJK) is his message
 * again; a short phrase of his is fine; paths, links, ids and code are proof and never count; only
 * his last six messages are compared. Both doors that write a node's words as the summary
 * (threads-model.ts updateThread, status-threads.ts the status line) call it.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { summaryRepeatsHim } from '../../../src/core/org/thread-summary-content.js'

const HIS = 'Please check why the orchard sprinkler in bed three keeps leaking every night after the timer runs'
/** "Please check why the sprinkler in bed three keeps leaking every night after the timer runs" (Chinese, escaped). */
const HIS_ZH = '\u8bf7\u67e5\u4e00\u4e0b\u4e09\u53f7\u82d7\u5e8a\u7684\u55b7\u6c34\u5934\u4e3a\u4ec0\u4e48\u6bcf\u5929\u665a\u4e0a\u5b9a\u65f6\u5668\u8dd1\u5b8c\u4ee5\u540e\u90fd\u4f1a\u6f0f\u6c34'

describe('a summary that repeats him', () => {
  it('his message said back is refused, in English and in Chinese', () => {
    expect(summaryRepeatsHim(`You asked: ${HIS}. Looking into it.`, [HIS])).toMatch(/repeats the user's own message/)
    expect(summaryRepeatsHim(`\u4f60\u8bf4\uff1a${HIS_ZH}\u3002\u6b63\u5728\u67e5\u3002`, [HIS_ZH])).toMatch(/repeats/)
  })

  it('a short phrase of his, or the matter in other words, is fine', () => {
    expect(summaryRepeatsHim('The bed three sprinkler leaks because the valve seal is worn; a new seal is on order for Friday.', [HIS])).toBeNull()
    expect(summaryRepeatsHim(`The leak: ${HIS.slice(20, 60)}, fixed with a new seal.`, [HIS])).toBeNull()
    expect(summaryRepeatsHim(`\u55b7\u6c34\u5934\u7684\u9600\u95e8\u5bc6\u5c01\u5708\u574f\u4e86\uff0c\u5468\u4e94\u6362\u65b0\u7684\u3002${HIS_ZH.slice(0, 12)}`, [HIS_ZH])).toBeNull()
  })

  it('a run just over the limit is caught wherever it starts in his message', () => {
    for (const start of [0, 1, 2, 3, 5]) {
      const part = HIS.slice(start, start + 73)
      expect(summaryRepeatsHim(`Status: ${part}.`, [HIS]), String(start)).not.toBeNull()
    }
  })

  it('paths, links, ids and code he gave are proof, never his words again', () => {
    const proof = '/home/orchard/logs/sprinkler-bed-three-timer-2026-11-23-night-run-full-output.txt'
    const his = `the log is at ${proof} and the ticket is th-0123456789ab, see https://example.com/orchard/sprinkler/bed-three/timer/night`
    expect(summaryRepeatsHim(`The leak is in the valve: ${proof}, https://example.com/orchard/sprinkler/bed-three/timer/night`, [his])).toBeNull()
  })

  it('only his last six messages are compared', () => {
    const others = Array.from({ length: 6 }, (_, i) => `the fence post number ${i} is loose`)
    expect(summaryRepeatsHim(`You asked: ${HIS}.`, [HIS, ...others])).toBeNull()
    expect(summaryRepeatsHim(`You asked: ${HIS}.`, [...others.slice(1), HIS])).not.toBeNull()
  })

  it('every door that writes a node\'s words as a summary calls it', () => {
    for (const file of ['src/core/org/threads-model.ts', 'src/core/sessions/status-threads.ts']) {
      expect(readFileSync(file, 'utf8'), file).toMatch(/summaryRepeatsHim\(/)
    }
  })
})
