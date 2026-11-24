/**
 * A switch refused for want of the engine's sign-in (server: core/sessions/engine-switch.ts
 * signInRefusal, which records the one not-signed-in sentence as the switch's error) reads as
 * that sign-in on the composer's switch line, with the way to it: "Open Settings to sign in". Any
 * other failure still reads its own error, as before.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import { notSignedInSentence } from '../../src/core/agents/engine-sign-in-words.js'

let EngineSwitchLine: typeof import('../../web/src/components/sessions/EngineSwitch').EngineSwitchLine
let MemoryRouter: typeof import('../../web/node_modules/react-router-dom').MemoryRouter
beforeAll(async () => {
  ;({ EngineSwitchLine } = await import('../../web/src/components/sessions/EngineSwitch'))
  ;({ MemoryRouter } = await import('../../web/node_modules/react-router-dom'))
})

const CATALOG = [{ id: 'antigravity', displayName: 'Antigravity' }] as never

function line(error: string): string {
  const server = {
    id: 'es-1', state: 'failed', at: '2026-11-24T00:00:00.000Z', from_session_id: 'sid-old',
    to: { engine: 'antigravity', host: '__local__' }, by: 'human', error, message: 'are you there?',
  }
  return renderToStaticMarkup(createElement(MemoryRouter, null,
    createElement(EngineSwitchLine, { pick: null, server: server as never, catalog: CATALOG, taskId: 't-1', onUndo: () => {} })))
}

const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;|&#39;/g, "'")

describe('the failed engine switch line', () => {
  it('a missing sign-in says so once, and leads to Settings', () => {
    const html = line(notSignedInSentence('antigravity', 'this Mac'))
    expect(text(html)).toContain('The switch to Antigravity did not start: Antigravity is not signed in on this Mac. The task stays on this session.')
    expect(text(html)).not.toContain('..')
    expect(html).toContain('data-testid="engine-sign-in-open-settings"')
    // The held message still offers Send here and Dismiss.
    expect(text(html)).toContain('Your message was not sent: are you there?')
    expect(text(html)).toContain('Send here')
    expect(text(html)).toContain('Dismiss')
  })

  it('any other failure reads its own error, with no sign-in way', () => {
    const html = line('engine would not start')
    expect(text(html)).toContain('The switch to Antigravity did not start: engine would not start. The task stays on this session.')
    expect(html).not.toContain('engine-sign-in-open-settings')
  })
})
