/**
 * OK on a page's confirm or prompt is the step it asks about (packages/browser-extension/src/
 * dialog-outward.ts): one whose words delete, buy or send waits for the person's yes, as the click
 * that would do it does; Cancel, an alert and a dialog that asks nothing of the kind go ahead. The
 * signature names the dialog, the page and a prompt's text, so one yes never gives another answer.
 */
import { describe, expect, it } from 'vitest'
import { dialogOutward } from '../../../packages/browser-extension/src/dialog-outward'

const URL_ = 'https://app.example.test/projects/7#top'

describe('accepting a dialog', () => {
  it('a confirm that deletes waits; its hold names the dialog and the page', () => {
    const h = dialogOutward({ type: 'confirm', message: 'Delete this project?' }, true, undefined, URL_)
    expect(h).toMatchObject({ kind: 'delete', what: 'accept the confirm "Delete this project?"', url: 'https://app.example.test/projects/7' })
    expect(h!.sig).toBe('delete|accept the confirm "Delete this project?"|https://app.example.test/projects/7||')
  })

  it('Cancel, an alert, a leave-page question and a plain confirm go ahead', () => {
    expect(dialogOutward({ type: 'confirm', message: 'Delete this project?' }, false, undefined, URL_)).toBeNull()
    expect(dialogOutward({ type: 'alert', message: 'Delete failed.' }, true, undefined, URL_)).toBeNull()
    expect(dialogOutward({ type: 'beforeunload', message: '' }, true, undefined, URL_)).toBeNull()
    expect(dialogOutward({ type: 'confirm', message: 'Leave this page? Changes you made may not be saved.' }, true, undefined, URL_)).toBeNull()
  })

  it('a word past the first 80 characters still counts: each sentence is judged', () => {
    const msg = 'You have three drafts open in this workspace and the newest one was saved a minute ago. Place your order now?'
    expect(dialogOutward({ type: 'confirm', message: msg }, true, undefined, URL_)).toMatchObject({ kind: 'buy' })
  })

  it('a prompt that sends: its text is the message, and another text is another step', () => {
    const a = dialogOutward({ type: 'prompt', message: 'Post this reply?' }, true, 'Thanks!', URL_)
    expect(a).toMatchObject({ kind: 'send', message: 'Thanks!' })
    const b = dialogOutward({ type: 'prompt', message: 'Post this reply?' }, true, 'Something else', URL_)
    expect(b!.sig).not.toBe(a!.sig)
  })
})
