/**
 * What the side panel's and the popup's Ask view tell the extension page so that its placeholder,
 * drawn while the frame loads, is the view itself (web/src/popout/ext-snapshot.ts askViewSnapOf,
 * read by packages/browser-extension/src/panel-snap.ts cleanAsk), and the theme the frame tells it
 * (web/src/popout/ext-theme.ts).
 */
import { describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'
import { NO_PAGE_SNAP_KEY, SNAP_CONTINUE, askViewSnapOf } from '../../web/src/popout/ext-snapshot'
import { frameThemeOf } from '../../web/src/popout/ext-theme'

function root(html: string): ParentNode {
  return parseHTML(`<!DOCTYPE html><html><body><div class="ext-panel">${html}</div></body></html>`).document.querySelector('.ext-panel')!
}

const head = (title: string | null, agent: string) => `<header class="ext-ask-head">${title === null ? '' : `<div class="ext-ask-titles"><span data-testid="ext-ask-title">${title}</span>`}<button class="ext-ask-agent">${agent}<span aria-hidden="true"></span></button>${title === null ? '' : '</div>'}</header>`
const row = (title: string, line: string, time: string, needs: boolean) => `<button data-testid="ext-continue-row" data-needs="${needs}"><span class="ask-walnut-drawer-needs"></span><span class="ask-walnut-drawer-item-text"><span class="ask-walnut-drawer-item-title">${title}</span><span class="ask-walnut-drawer-item-line">${line}</span></span><span class="ask-walnut-drawer-item-time">${time}</span></button>`
const chips = `<div class="draft-walnut-suggests"><button class="session-action-chip" aria-label="Which task is …"><span class="session-action-chip-ic"></span>Which task is<span class="session-action-chip-blank"></span></button><button class="session-action-chip"><span class="session-action-chip-ic"></span>Schedule my day</button><button class="session-action-chip"><span class="session-action-chip-ic"></span>What ran today</button></div>`
const composer = (placeholder: string, pageOn: boolean) => `<div class="chat-input-box"><textarea placeholder="${placeholder}"></textarea><button data-testid="ext-panel-include" role="switch" aria-checked="${pageOn}">Docs</button></div>`

describe('the Ask view as the placeholder draws it', () => {
  it('a new chat in the side panel: title, agent, Continue rows, chips, placeholder, page chip', () => {
    const s = askViewSnapOf(root(head('New chat', 'Ask Walnut')
      + `<div data-testid="ext-continue">${row('Compare two laptops', 'Zen 14 wins.', '3h ago', false)}${row('Draft a reply', 'Say yes to 3 pm?', '1d ago', true)}</div>`
      + chips + composer('Ask Walnut, or ask it to do something here…', true)))
    expect(s).toEqual({
      askTitle: 'New chat',
      agent: 'Ask Walnut',
      placeholder: 'Ask Walnut, or ask it to do something here…',
      continue: [
        { title: 'Compare two laptops', line: 'Zen 14 wins.', time: '3h ago', needs: false },
        { title: 'Draft a reply', line: 'Say yes to 3 pm?', time: '1d ago', needs: true },
      ],
      // The stem chip as its label reads it, never cut.
      suggestions: ['Which task is …', 'Schedule my day', 'What ran today'],
      pageOn: true,
    })
  })

  it('a conversation: its title, the follow-up placeholder, no Continue or chips, the page chip off', () => {
    const s = askViewSnapOf(root(head('Uploads in release 4.2', 'Ask Walnut') + composer('Ask a follow-up…', false)))
    expect(s).toEqual({ askTitle: 'Uploads in release 4.2', agent: 'Ask Walnut', placeholder: 'Ask a follow-up…', pageOn: false })
  })

  it('the popup: the agent alone in its header; Continue cut to what the placeholder draws', () => {
    const rows = Array.from({ length: SNAP_CONTINUE + 3 }, (_, i) => row(`Ask ${i}`, '', '', false)).join('')
    const s = askViewSnapOf(root(head(null, 'Ask Walnut') + `<div data-testid="ext-continue">${rows}</div>` + composer('Ask Walnut, or ask it to do something here…', true)))
    expect(s.askTitle).toBeUndefined()
    expect(s.agent).toBe('Ask Walnut')
    expect(s.continue).toHaveLength(SNAP_CONTINUE)
    expect(s.continue?.[0]).toEqual({ title: 'Ask 0', line: '', time: '', needs: false })
  })

  it('long words are cut short, as the extension keeps them', () => {
    const long = 'x'.repeat(400)
    const s = askViewSnapOf(root(head(long, 'Ask Walnut') + composer(long, true)))
    expect(s.askTitle!.length).toBeLessThanOrEqual(200)
    expect(s.placeholder!.length).toBeLessThanOrEqual(120)
  })

  it('a tab with no web page has a key of its own', () => {
    expect(NO_PAGE_SNAP_KEY).toBe('web:none')
  })
})

describe("the frame's theme, told to the extension page", () => {
  it("light or dark as picked, else the system's", () => {
    expect(frameThemeOf('dark')).toBe('dark')
    expect(frameThemeOf('light')).toBe('light')
    expect(frameThemeOf(undefined)).toBe('system')
    expect(frameThemeOf(null)).toBe('system')
    expect(frameThemeOf('system')).toBe('system')
    expect(frameThemeOf('sepia')).toBe('system')
  })
})
