/**
 * What the person reads on the approval card for an agent's buy, send or delete
 * (src/core/browser-control/outward-asks.ts askWords), and where they are told to approve
 * (src/core/approvals/signer-words.ts): who asks (the task's name, else "a Walnut agent"),
 * exactly what (the button, the site; for a send its message, for an order its total), why it
 * waits (the reason the agent is told, said once), plain grammar, and only the devices the person
 * really has.
 */
import { describe, expect, it } from 'vitest'
import { askWords, type Hold } from '../../../src/core/browser-control/outward-asks'
import { howToApprove, signerKinds, whereAsked } from '../../../src/core/approvals/signer-words'
import { orderTotal } from '../../../packages/browser-extension/src/page-agent-outward'

const hold = (h: Partial<Hold>): Hold => ({ kind: 'buy', why: '"Place order" buys or pays', what: 'click button "Place order"', url: 'https://shop.example.test/checkout', sig: 's', ...h })

describe('the card says who asks and exactly what', () => {
  it('a task by its name; an order with the total the page shows', () => {
    const w = askWords(hold({ total: '$42.10' }), 'Order lunch')
    expect(w.what).toBe('Let "Order lunch" click button "Place order" on shop.example.test ($42.10)? It buys or pays.')
    expect(w.detail).toContain('The task "Order lunch" wants to click button "Place order" in your browser')
    expect(w.detail).toContain('Order total on the page: $42.10')
    expect(w.detail).toContain('Page: https://shop.example.test/checkout')
  })

  it('no task: "a Walnut agent", never "A Walnut agent" mid-sentence, never a host id', () => {
    const w = askWords(hold({ kind: 'send', why: '"Send feedback" sends or posts', what: 'click button "Send feedback"', url: 'https://news.example.test/', message: 'Great update, thanks' }))
    expect(w.what).toBe('Let a Walnut agent click button "Send feedback" on news.example.test: "Great update, thanks"? It sends or posts.')
    expect(w.what).not.toMatch(/Let A /)
    expect(w.detail).toContain('Message it sends: Great update, thanks')
    expect(w.detail).not.toMatch(/[0-9a-f]{12}/)
  })

  it('a long message or task name still fits the 300-character title, whole in the detail', () => {
    const message = 'x'.repeat(290)
    const w = askWords(hold({ kind: 'send', message }), 'T'.repeat(200))
    expect(w.what.length).toBeLessThanOrEqual(300)
    // The reason is never what gives way.
    expect(w.what.endsWith('? It sends or posts.')).toBe(true)
    expect(w.detail).toContain(message)
  })

  it('why it waits, as the agent is told it: a button by its kind, a form or a key in its own words', () => {
    expect(askWords(hold({ kind: 'delete', why: '"Remove" deletes something', what: 'click button "Remove"' })).what).toMatch(/\? It deletes something\.$/)
    expect(askWords(hold({ why: 'it sends a form with card details', what: 'press Enter in the card form' })).what).toMatch(/\? It sends a form with card details\.$/)
    expect(askWords(hold({ kind: 'send', why: 'Enter sends the message in that box', what: 'press Enter in the message box' })).what).toMatch(/\? Enter sends the message in that box\.$/)
  })
})

describe('the order total a page shows', () => {
  it.each([
    ['Subtotal $40.00\nShipping $2.10\nOrder total: $42.10', '$42.10'],
    ['Total €19,99', '€19,99'],
    ['Total: €19.99', '€19.99'],
    ['Grand total 1,250.00 USD\nTotal items: 3', '1,250.00 USD'],
    ['Items 3\nTotal $9.50', '$9.50'],
    ['No prices here', undefined],
  ])('%j', (text, want) => {
    expect(orderTotal(text)).toBe(want)
  })
})

describe('where to approve names only the devices the person has', () => {
  const key = (kind: string, status = 'active') => ({ kind, status })
  it('no signing device: Passwords unlock in this window, no iPhone, no Mac app', () => {
    const t = howToApprove(signerKinds([]), { unlock: true })
    expect(t).toBe('Unlock Passwords in this window to approve.')
    expect(whereAsked([])).toBe('They are asked in Walnut (a notification wherever it is open)')
  })
  it('an iPhone only', () => {
    expect(howToApprove(signerKinds([key('iphone')]), { unlock: true })).toBe('Approve it on your iPhone with Face ID, or unlock Passwords in this window.')
    expect(whereAsked(['iphone'])).toContain('and on their iPhone')
  })
  it('both, and a pending key does not count', () => {
    expect(signerKinds([key('mac-app'), key('iphone'), key('iphone', 'pending')])).toEqual(['iphone', 'mac-app'])
    expect(signerKinds([key('mac-app', 'pending')])).toEqual([])
    expect(howToApprove(['iphone', 'mac-app'], { unlock: false })).toBe('Approve it on your iPhone with Face ID, or in the Walnut Mac app with Touch ID.')
  })
})
