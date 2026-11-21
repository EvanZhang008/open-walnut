/**
 * Voice conversation's state machine (web/src/voice/conversation-machine.ts):
 * every path a conversation takes, and the effects each step asks for.
 */
import { describe, expect, it } from 'vitest'
import { openVoice, reduceVoice, type VoiceEvent, type VoiceState } from '../../../web/src/voice/conversation-machine'

function run(events: VoiceEvent[], from: VoiceState = openVoice().state) {
  let state = from
  const effects: string[] = []
  for (const e of events) {
    const step = reduceVoice(state, e)
    state = step.state
    effects.push(...step.effects.map((x) => x.type))
  }
  return { state, effects }
}

describe('voice conversation', () => {
  it('opens listening with a take started', () => {
    const open = openVoice()
    expect(open.state.phase).toBe('listening')
    expect(open.effects).toEqual([{ type: 'start-take', take: 1 }])
  })

  it('a full round: talk, pause, send, answer read, listening again', () => {
    const { state, effects } = run([
      { type: 'speech-start' },
      { type: 'end-of-speech' },
      { type: 'transcribed', take: 1, text: ' What is on today? ' },
      { type: 'reply', spoken: 'Two meetings and a review.' },
      { type: 'speech-done' },
    ])
    expect(effects).toEqual(['finish-take', 'send', 'speak', 'start-take'])
    expect(state.phase).toBe('listening')
    expect(state.lastHeard).toBe('What is on today?')
    expect(state.lastSpoken).toBe('Two meetings and a review.')
    expect(state.take).toBe(2)
  })

  it('a pause before any speech does nothing; noise that transcribes to nothing keeps listening', () => {
    expect(run([{ type: 'end-of-speech' }]).state.phase).toBe('listening')
    const { state, effects } = run([{ type: 'speech-start' }, { type: 'end-of-speech' }, { type: 'transcribed', take: 1, text: '   ' }])
    expect(state.phase).toBe('listening')
    expect(effects).toEqual(['finish-take', 'start-take'])
  })

  it('talking over the answer stops it and listens', () => {
    const speaking = run([{ type: 'speech-start' }, { type: 'end-of-speech' }, { type: 'transcribed', take: 1, text: 'hi' }, { type: 'reply', spoken: 'Hello.' }]).state
    const { state, effects } = run([{ type: 'barge-in' }], speaking)
    expect(effects).toEqual(['stop-speaking', 'start-take'])
    expect(state.phase).toBe('listening')
    // The interrupted voice's late end does not start another take.
    expect(run([{ type: 'speech-done' }], state).effects).toEqual([])
  })

  it('a late transcription of an older take is dropped', () => {
    const transcribing = run([{ type: 'speech-start' }, { type: 'end-of-speech' }]).state
    expect(run([{ type: 'transcribed', take: 0, text: 'old' }], transcribing).state.phase).toBe('transcribing')
  })

  it('an answer never cuts in while the person is talking', () => {
    const talking = run([{ type: 'speech-start' }]).state
    const { state, effects } = run([{ type: 'reply', spoken: 'Report.' }], talking)
    expect(state.phase).toBe('listening')
    expect(effects).toEqual([])
  })

  it('an answer of a turn the session started itself is read while the person is quiet', () => {
    const { state, effects } = run([{ type: 'reply', spoken: 'The build finished.' }])
    expect(state.phase).toBe('speaking')
    expect(effects).toEqual(['discard-take', 'speak'])
  })

  it('an answer with nothing speakable goes back to listening', () => {
    const waiting = run([{ type: 'speech-start' }, { type: 'end-of-speech' }, { type: 'transcribed', take: 1, text: 'hi' }]).state
    const { state, effects } = run([{ type: 'reply', spoken: null }], waiting)
    expect(state.phase).toBe('listening')
    expect(effects).toEqual(['start-take'])
  })

  it('the button: send now, stop listening, say more, interrupt, talk again', () => {
    expect(run([{ type: 'speech-start' }, { type: 'tap' }]).effects).toEqual(['finish-take'])
    const paused = run([{ type: 'tap' }])
    expect(paused.state.phase).toBe('paused')
    expect(paused.effects).toEqual(['discard-take'])
    expect(run([{ type: 'tap' }], paused.state).state.phase).toBe('listening')
    const waiting = run([{ type: 'speech-start' }, { type: 'end-of-speech' }, { type: 'transcribed', take: 1, text: 'hi' }]).state
    expect(run([{ type: 'tap' }], waiting).state.phase).toBe('listening')
    const speaking = run([{ type: 'reply', spoken: 'Hello.' }]).state
    expect(run([{ type: 'tap' }], speaking).effects).toEqual(['stop-speaking', 'start-take'])
    const transcribing = run([{ type: 'speech-start' }, { type: 'end-of-speech' }]).state
    expect(run([{ type: 'tap' }], transcribing).effects).toEqual([])
  })

  it('failures pause with a sentence, and the next tap listens with the error cleared', () => {
    const failed = run([{ type: 'speech-start' }, { type: 'end-of-speech' }, { type: 'transcribe-failed', take: 1, error: 'Could not hear that' }]).state
    expect(failed.phase).toBe('paused')
    expect(failed.error).toBe('Could not hear that')
    expect(run([{ type: 'tap' }], failed).state.error).toBeNull()
    const sendFailed = run([{ type: 'speech-start' }, { type: 'end-of-speech' }, { type: 'transcribed', take: 1, text: 'hi' }, { type: 'send-failed', error: 'offline' }]).state
    expect(sendFailed.phase).toBe('paused')
    const speakFailed = run([{ type: 'reply', spoken: 'x' }, { type: 'speak-failed', error: 'no voice' }]).state
    expect(speakFailed.phase).toBe('listening')
    expect(speakFailed.error).toBe('no voice')
  })

  it('a minute of silence turns the mic off', () => {
    const { state, effects } = run([{ type: 'idle-timeout' }])
    expect(state.phase).toBe('paused')
    expect(effects).toEqual(['discard-take'])
    expect(run([{ type: 'speech-start' }, { type: 'idle-timeout' }]).state.phase).toBe('listening')
  })

  it('every event in every phase gives a state (no phase is a dead end)', () => {
    const events: VoiceEvent[] = [
      { type: 'speech-start' }, { type: 'end-of-speech' }, { type: 'transcribed', take: 1, text: 'x' },
      { type: 'transcribe-failed', take: 1, error: 'e' }, { type: 'send-failed', error: 'e' }, { type: 'reply', spoken: 'x' },
      { type: 'reply', spoken: null }, { type: 'barge-in' }, { type: 'speech-done' }, { type: 'speak-failed', error: 'e' },
      { type: 'tap' }, { type: 'idle-timeout' },
    ]
    const base = openVoice().state
    for (const phase of ['listening', 'transcribing', 'waiting', 'speaking', 'paused'] as const) {
      for (const heard of [false, true]) {
        for (const e of events) {
          const step = reduceVoice({ ...base, phase, heard }, e)
          expect(['listening', 'transcribing', 'waiting', 'speaking', 'paused']).toContain(step.state.phase)
        }
        // From any phase, a tap and at most one more event lead back to listening.
        const tapped = reduceVoice({ ...base, phase, heard }, { type: 'tap' }).state
        const back = tapped.phase === 'listening' ? tapped : reduceVoice(tapped, { type: 'tap' }).state
        if (phase !== 'transcribing') expect(back.phase === 'listening' || back.phase === 'transcribing').toBe(true)
      }
    }
  })
})
