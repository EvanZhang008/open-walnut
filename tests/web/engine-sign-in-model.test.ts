/**
 * Settings > Sessions, "Antigravity sign-in" (web/src/components/settings/sections/engine-sign-in-model.ts):
 * what each host's row says and offers, the words of each refusal, the chat's deep link to a
 * host's row, and the one sentence the server writes and the chat reads back
 * (src/core/agents/engine-sign-in-words.ts). Also the effort names an engine's own options show.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  BAD_CODE_WORDS, __resetSignInRequestForTests, codeEndsSignIn, openEngineSignIn, refusalWords, requestNames, rowView,
  signInGroupId, signInRowId, takeSignInRequest,
} from '../../web/src/components/settings/sections/engine-sign-in-model'
import type { EngineSignInStatus } from '../../web/src/api/engine-sign-in'
import { ApiError } from '../../web/src/api/api-error'
import { notSignedInSentence, parseNotSignedIn } from '../../src/core/agents/engine-sign-in-words'
import { notSignedInWords } from '../../src/core/agents/engine-sign-in'
import { resolvePane } from '../../web/src/components/settings/settings-routing'
import { isWalnutRowAnchor } from '../../web/src/components/settings/settings-legacy-links'
import { acpEffortOptionName } from '../../web/src/components/sessions/acp-model-id'
import { ENGINE_FULL_NAMES } from '../../src/core/agents/engine-names'
import type { SessionEngine } from '../../src/core/types'

function status(over: Partial<EngineSignInStatus> = {}): EngineSignInStatus {
  return {
    engine: 'antigravity', host: 'devbox', hostName: 'devbox', state: 'not_signed_in', installed: true, version: '1.5.14',
    reason: null, method: null, google: false, apiKey: { set: false, source: null }, signIn: null,
    install: { state: 'idle', command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', canInstall: false },
    checkedAt: '2026-11-23T00:00:00.000Z', ...over,
  }
}

describe('a host row at rest', () => {
  it('says each state in one word and offers its one step', () => {
    expect(rowView(status(), 'antigravity')).toMatchObject({ tone: 'muted', word: 'Not signed in', action: 'sign-in', actionLabel: 'Sign in with Google' })
    expect(rowView(status({ state: 'signed_in', method: 'google', google: true }), 'antigravity'))
      .toMatchObject({ tone: 'ok', word: 'Signed in with Google', action: 'sign-out', actionLabel: 'Sign out' })
    expect(rowView(status({ state: 'signed_in', method: 'api-key', apiKey: { set: true, source: 'settings' } }), 'antigravity'))
      .toMatchObject({ tone: 'ok', word: 'Signed in with API key', action: 'remove-key', actionLabel: 'Remove key' })
    // A key in the host's own environment is not Walnut's to remove.
    expect(rowView(status({ state: 'signed_in', method: 'api-key', apiKey: { set: true, source: 'host-env' } }), 'antigravity'))
      .toMatchObject({ word: 'Signed in with API key', action: null })
  })

  it('offers the install with its command only where the host can run it', () => {
    const missing = status({ state: 'not_installed', installed: false, reason: 'agy is not installed', install: { ...status().install, canInstall: true } })
    expect(rowView(missing, 'antigravity')).toMatchObject({
      word: 'Not installed', action: 'install', actionLabel: 'Install on devbox', installCommand: status().install.command, title: 'agy is not installed',
    })
    expect(rowView({ ...missing, install: { ...missing.install, canInstall: false } }, 'antigravity').action).toBeNull()
  })

  it('tells a host never dialled from one that did not answer, and an old daemon from both', () => {
    expect(rowView(status({ state: 'unknown', connected: false }), 'antigravity')).toMatchObject({ word: 'Not connected', action: 'check', actionLabel: 'Check now' })
    expect(rowView(status({ state: 'unknown', reason: 'could not reach devbox' }), 'antigravity'))
      .toMatchObject({ tone: 'warn', word: "Can't reach devbox now", action: 'check', title: 'could not reach devbox' })
    expect(rowView(status({ state: 'unknown', needsDaemonUpdate: true }), 'antigravity')).toMatchObject({ tone: 'warn', word: 'Daemon needs update', action: null })
  })
})

describe('the words of a refusal', () => {
  const refused = (status: number, code: string, message = code) => new ApiError(status, message, { error: message, code })

  it('says what to do about a code Google did not take, and which refusals ended the sign-in', () => {
    expect(BAD_CODE_WORDS).toBe("That code didn't work. Open Google sign-in to get a new one.")
    expect(refusalWords(refused(400, 'bad_code', 'invalid_grant'), 'finish', 'devbox')).toBe(BAD_CODE_WORDS)
    expect(refusalWords(refused(400, 'invalid_code', 'the code is empty'), 'finish', 'devbox')).toBe(BAD_CODE_WORDS)
    expect(refusalWords(refused(504, 'timeout'), 'finish', 'devbox')).toMatch(/did not finish in time/)
    expect(codeEndsSignIn('bad_code')).toBe(true)
    expect(codeEndsSignIn('timeout')).toBe(true)
    // A malformed code never reached the CLI: its sign-in still waits.
    expect(codeEndsSignIn('invalid_code')).toBe(false)
  })

  it('names the host that did not answer, and a person-only step', () => {
    expect(refusalWords(refused(504, 'host_unreachable'), 'start', 'devbox')).toBe("Can't reach devbox now. Try again once it is connected.")
    expect(refusalWords(refused(403, 'human_only'), 'sign-out', 'devbox')).toMatch(/Only you/)
    expect(refusalWords(refused(400, 'invalid_key', 'the key must be one token without spaces'), 'key', 'devbox')).toBe('The key must be one token without spaces.')
    expect(refusalWords(new Error('boom'), 'start', 'devbox')).toBe('Could not start the sign-in on devbox: boom')
  })
})

describe("the chat's link to a host's sign-in", () => {
  afterEach(() => __resetSignInRequestForTests())

  it('lands on the row (or the group when only the name is known) and is taken once, by that row only', () => {
    const went: string[] = []
    openEngineSignIn((to) => went.push(to), { engine: 'antigravity', host: 'box:2222', hostName: 'Build box' })
    expect(went).toEqual(['/settings#engine-sign-in-antigravity-box%3A2222'])
    expect(signInRowId('antigravity', 'box:2222')).toBe('engine-sign-in-antigravity-box:2222')
    expect(takeSignInRequest(status({ host: 'devbox' }))).toBeNull()
    expect(takeSignInRequest(status({ host: 'box:2222' }))?.host).toBe('box:2222')
    expect(takeSignInRequest(status({ host: 'box:2222' }))).toBeNull()

    openEngineSignIn((to) => went.push(to), { engine: 'antigravity', hostName: 'This Mac' })
    expect(went[1]).toBe(`/settings#${signInGroupId('antigravity')}`)
    expect(requestNames({ engine: 'antigravity', hostName: 'this Mac' }, status({ host: '__local__', hostName: 'this Mac' }))).toBe(true)
    expect(requestNames({ engine: 'codex', hostName: 'this Mac' }, status({ host: '__local__', hostName: 'this Mac' }))).toBe(false)
  })

  it('opens Settings > Sessions at that row, a host alias with a port included', () => {
    for (const id of [signInRowId('antigravity', 'box:2222'), signInGroupId('antigravity')]) {
      expect(resolvePane(`#${encodeURIComponent(id)}`, { silent: true })).toMatchObject({ paneId: 'sessions', targetId: id, known: true, row: true })
      expect(isWalnutRowAnchor(id)).toBe(true)
    }
  })
})

describe('the not-signed-in sentence', () => {
  it('is the one the server writes, and reads back for every engine and host name', () => {
    expect(notSignedInWords('antigravity', 'devbox')).toBe('Antigravity is not signed in on devbox. Open Settings to sign in.')
    for (const engine of Object.keys(ENGINE_FULL_NAMES) as SessionEngine[]) {
      for (const hostName of ['this Mac', 'dev.example.test', 'Build box (2)']) {
        expect(parseNotSignedIn(notSignedInSentence(engine, hostName))).toEqual({ engine, hostName, line: `${ENGINE_FULL_NAMES[engine]} is not signed in on ${hostName}.` })
      }
    }
    expect(parseNotSignedIn('Antigravity is not signed in on devbox.')?.hostName).toBe('devbox')
    expect(parseNotSignedIn('Nobody is not signed in on devbox.')).toBeNull()
    expect(parseNotSignedIn('Send failed: socket closed')).toBeNull()
    expect(parseNotSignedIn(undefined)).toBeNull()
  })
})

describe("an engine's own effort names", () => {
  it("read as Walnut's for the levels Walnut knows, the engine's own otherwise", () => {
    expect(acpEffortOptionName({ value: 'xhigh', name: 'Extra' })).toBe('X-High')
    expect(acpEffortOptionName({ value: 'high', name: 'High' })).toBe('High')
    expect(acpEffortOptionName({ value: 'ultra', name: 'Ultra' })).toBe('Ultra')
  })
})
