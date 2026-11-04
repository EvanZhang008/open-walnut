/**
 * Which agent steps in the person's browser wait for their yes
 * (packages/browser-extension/src/page-agent-outward.ts judgeOutward), as a table: buying, paying,
 * placing an order, sending a checkout's card form, sending, posting, publishing, sending a form
 * with a message, deleting, removing an account wait; searching, signing in, Next, filtering,
 * opening, Add to cart and links that only go to a page do not. Add to cart is decided as not
 * outward: nothing leaves the person's hands until the order is placed (that step asks).
 */
import { describe, expect, it } from 'vitest'
import { judgeOutward, keyActs, trustedOutward, type OutwardFacts } from '../../../packages/browser-extension/src/page-agent-outward'

const button = (name: string, extra: Partial<OutwardFacts> = {}): OutwardFacts => ({ name, ...extra })

const OUTWARD: Array<[string, OutwardFacts, 'buy' | 'send' | 'delete']> = [
  ['Buy now', button('Buy now'), 'buy'],
  ['Pay $42.00', button('Pay $42.00'), 'buy'],
  ['Pay with card', button('Pay with card'), 'buy'],
  ['Place order', button('Place order'), 'buy'],
  ['Place your order', button('Place your order'), 'buy'],
  ['Complete purchase', button('Complete purchase'), 'buy'],
  ['Confirm and pay', button('Confirm and pay'), 'buy'],
  ['aria-label "Purchase" on an icon button', button('Purchase'), 'buy'],
  ['a plain "Continue" that sends a card form (checkout submit)', button('Continue', { submits: true, form: { payment: true } }), 'buy'],
  ['Send', button('Send'), 'send'],
  ['Send feedback', button('Send feedback'), 'send'],
  ['Post', button('Post'), 'send'],
  ['Publish', button('Publish'), 'send'],
  ['Tweet', button('Tweet'), 'send'],
  ['Submit review', button('Submit review'), 'send'],
  ['a plain "Submit" that sends a form with a message', button('Submit', { submits: true, form: { message: true } }), 'send'],
  ['Enter in a chat box holding a message', { name: '', enterInMessage: true }, 'send'],
  ['Delete', button('Delete'), 'delete'],
  ['Delete repository', button('Delete repository'), 'delete'],
  ['a "Delete" link (a page that deletes)', button('Delete', { navigates: true }), 'delete'],
  ['Remove account', button('Remove account'), 'delete'],
  ['Close my account', button('Close my account'), 'delete'],
  ['Cancel subscription', button('Cancel subscription'), 'delete'],
]

const NOT_OUTWARD: Array<[string, OutwardFacts]> = [
  ['Search', button('Search', { submits: true, form: {} })],
  ['a search form whose box is a textarea', button('Search', { submits: true, form: { message: true, search: true } })],
  ['Sign in', button('Sign in', { submits: true, form: {} })],
  ['Log in', button('Log in')],
  ['Next', button('Next', { submits: true, form: {} })],
  ['Continue', button('Continue')],
  ['Send code (to the person themself, signing in)', button('Send code')],
  ['Send me a link', button('Send me a link')],
  ['Add to cart', button('Add to cart')],
  ['Add to cart in a form', button('Add to cart', { submits: true, form: {} })],
  ['Proceed to checkout', button('Proceed to checkout')],
  ['Checkout now', button('Checkout now')],
  ['Filter', button('Filter')],
  ['Apply filters', button('Apply filters')],
  ['Open', button('Open')],
  ['a "Buy" link to a product page', button('Buy', { navigates: true })],
  ['a "Post a job" link', button('Post a job', { navigates: true })],
  ['Payment methods', button('Payment methods')],
  ['Posts', button('Posts')],
  ['Resend', button('Resend')],
  ['Undelete', button('Undelete')],
  ['Remove (an item from the cart)', button('Remove')],
  ['a card field without a submit (typing)', button('', { form: { payment: true } })],
]

describe('outward steps wait for the person', () => {
  it.each(OUTWARD)('%s', (_name, facts, kind) => {
    expect(judgeOutward(facts)?.kind).toBe(kind)
  })

  it.each(NOT_OUTWARD)('%s does not ask', (_name, facts) => {
    expect(judgeOutward(facts)).toBeNull()
  })

  it('says why in plain words', () => {
    expect(judgeOutward(button('Place order'))?.why).toBe('"Place order" buys or pays')
    expect(judgeOutward(button('Continue', { submits: true, form: { payment: true } }))?.why).toBe('it sends a form with card details')
  })
})

/**
 * Which pressed keys can send (page-agent-outward.ts keyActs): every combo that ends in Enter,
 * because Control+Enter and Meta+Enter send in many apps, and Space, which works a focused button.
 * The page then judges what that key would do where the focus is (pressFacts).
 */
describe('keys that can send are judged', () => {
  it.each([
    ['Enter', 'enter'], ['Control+Enter', 'enter'], ['Meta+Enter', 'enter'], ['Shift+Enter', 'enter'],
    ['Alt+Control+Enter', 'enter'], ['NumpadEnter', 'enter'], ['Return', 'enter'],
    [' ', 'activate'], ['Space', 'activate'], ['Shift+Space', 'activate'],
  ])('%s', (combo, how) => {
    expect(keyActs(combo)).toBe(how)
  })

  it.each(['a', 'Tab', 'Escape', 'ArrowDown', 'Control+a', 'Meta+c', 'Backspace', 'F5'])('%s is not', (combo) => {
    expect(keyActs(combo)).toBeNull()
  })
})

/** Real input asks the page to judge every step that can send (agent-trusted.ts uses trustedOutward). */
describe('real input is judged like page events', () => {
  it('a click, and every key (the page judges the combo where the focus is)', () => {
    expect(trustedOutward('click', { ref: 'e3' })).toEqual({ outward: 'click' })
    expect(trustedOutward('press', { key: 'Meta+Enter' })).toEqual({ outward: 'key', key: 'Meta+Enter' })
    expect(trustedOutward('press', { key: ' ' })).toEqual({ outward: 'key', key: ' ' })
  })

  it('typed text with a newline counts as submit (real typing presses Enter for it)', () => {
    expect(trustedOutward('type', { text: 'hello\nthere' })).toEqual({ outward: 'enter', typing: 'hello\nthere' })
    expect(trustedOutward('type', { text: 'hello', submit: true })).toEqual({ outward: 'enter', typing: 'hello' })
    expect(trustedOutward('type', { text: 'hello' })).toEqual({})
  })

  it('hover and upload are not judged', () => {
    expect(trustedOutward('hover', {})).toEqual({})
    expect(trustedOutward('upload', {})).toEqual({})
  })
})
