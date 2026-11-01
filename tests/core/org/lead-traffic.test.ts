/** Who last wrote to whom (src/core/org/lead-traffic.ts): a worker's wait it told its lead itself is no news. */
import { describe, it, expect, beforeEach } from 'vitest'
import { _resetLeadTrafficForTesting, noteSent, senderTaskOf, workerToldLead } from '../../../src/core/org/lead-traffic.js'

beforeEach(() => _resetLeadTrafficForTesting())

describe('lead traffic', () => {
  it('reads the sender of a peer note, a reply and a request fallback; nothing else', () => {
    expect(senderTaskOf('<walnut-message kind="peer-note" from="W [1]" from-task="w-1" title="Land">\nwalnut-cloud land w-1\n</walnut-message>')).toBe('w-1')
    expect(senderTaskOf('<walnut-message kind="reply" from="W [1]" from-task="w-1" request="rq-1">\ndone\n</walnut-message>')).toBe('w-1')
    expect(senderTaskOf('<walnut-message kind="notification" from="Walnut" about-task="w-1" request="rq-1" outcome="completed">\nIts turn ended\n</walnut-message>')).toBe('w-1')
    // A Walnut status notice about a task, the lead's own team note, or a person's words: no sender.
    expect(senderTaskOf('<walnut-message kind="notification" from="Walnut" about-task="lead" outcome="org-update">\n</walnut-message>')).toBeNull()
    expect(senderTaskOf('Please land it')).toBeNull()
    expect(senderTaskOf('hello <walnut-message kind="peer-note" from-task="w-1">')).toBeNull()
  })

  it('the worker told the lead while its newest message to the lead is newer than the lead\'s to it', () => {
    expect(workerToldLead('w', 'lead')).toBe(false)
    noteSent('w', 'lead', 100)
    expect(workerToldLead('w', 'lead')).toBe(true)
    // The lead wrote back: a wait after that, with nothing new from the worker, is news again.
    noteSent('lead', 'w', 200)
    expect(workerToldLead('w', 'lead')).toBe(false)
    noteSent('w', 'lead', 300)
    expect(workerToldLead('w', 'lead')).toBe(true)
    // Another pair says nothing about this one.
    expect(workerToldLead('v', 'lead')).toBe(false)
    expect(workerToldLead('w', 'other-lead')).toBe(false)
  })
})
