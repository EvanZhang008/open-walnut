/**
 * OK on a page's confirm or prompt is the step it asks about (packages/browser-extension/src/
 * dialog-outward.ts). Only one whose words buy or pay waits for the person's yes, as the click
 * that would do it does (2026-11-17, the user: "Only ask me for payment, that is it"); every other
 * dialog is the agent's to decide, a confirm that deletes or a prompt that posts included. Cancel
 * and an alert never wait. The signature names the dialog, the page and a prompt's text, so one
 * yes never gives another answer.
 */
import { describe, expect, it } from 'vitest'
import { dialogOutward } from '../../../packages/browser-extension/src/dialog-outward'

const URL_ = 'https://app.example.test/projects/7#top'

describe('accepting a dialog', () => {
  it('a confirm that pays waits; its hold names the dialog and the page', () => {
    const h = dialogOutward({ type: 'confirm', message: 'Place your order for $42?' }, true, undefined, URL_)
    expect(h).toMatchObject({ kind: 'buy', what: 'accept the confirm "Place your order for $42?"', url: 'https://app.example.test/projects/7' })
    expect(h!.sig).toBe('buy|accept the confirm "Place your order for $42?"|https://app.example.test/projects/7||')
  })

  it('a confirm that deletes and a prompt that posts are the agent\'s to decide: no wait', () => {
    expect(dialogOutward({ type: 'confirm', message: 'Delete this project?' }, true, undefined, URL_)).toBeNull()
    expect(dialogOutward({ type: 'prompt', message: 'Post this reply?' }, true, 'Thanks!', URL_)).toBeNull()
  })

  it('Cancel, an alert, a leave-page question and a plain confirm go ahead', () => {
    expect(dialogOutward({ type: 'confirm', message: 'Place your order?' }, false, undefined, URL_)).toBeNull()
    expect(dialogOutward({ type: 'alert', message: 'Payment failed.' }, true, undefined, URL_)).toBeNull()
    expect(dialogOutward({ type: 'beforeunload', message: '' }, true, undefined, URL_)).toBeNull()
    expect(dialogOutward({ type: 'confirm', message: 'Leave this page? Changes you made may not be saved.' }, true, undefined, URL_)).toBeNull()
  })

  it('a word past the first 80 characters still counts: each sentence is judged', () => {
    const msg = 'You have three drafts open in this workspace and the newest one was saved a minute ago. Place your order now?'
    expect(dialogOutward({ type: 'confirm', message: msg }, true, undefined, URL_)).toMatchObject({ kind: 'buy' })
  })

  it('a prompt that pays: another text is another step', () => {
    const a = dialogOutward({ type: 'prompt', message: 'Pay now? Type the amount' }, true, '42', URL_)
    expect(a).toMatchObject({ kind: 'buy' })
    const b = dialogOutward({ type: 'prompt', message: 'Pay now? Type the amount' }, true, '43', URL_)
    expect(b!.sig).not.toBe(a!.sig)
  })
})
