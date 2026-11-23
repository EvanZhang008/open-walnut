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

  it('paused stays paused: an answer is kept for Replay, never read on its own', () => {
    const paused = run([{ type: 'tap' }]).state
    const { state, effects } = run([{ type: 'reply', spoken: 'Typed turn done.' }], paused)
    expect(state.phase).toBe('paused')
    expect(state.lastSpoken).toBe('Typed turn done.')
    expect(effects).toEqual([])
    // Replay is the person's own ask: it reads, then listens.
    const replayed = run([{ type: 'replay', spoken: 'Typed turn done.' }], state)
    expect(replayed.state.phase).toBe('speaking')
    expect(replayed.effects).toEqual(['speak'])
    expect(run([{ type: 'speech-done' }], replayed.state).state.phase).toBe('listening')
    // Never over the person's words.
    const talking = run([{ type: 'speech-start' }]).state
    expect(run([{ type: 'replay', spoken: 'x' }], talking).state.phase).toBe('listening')
  })

  it('a stopped turn (nothing to say) goes back to listening from waiting only', () => {
    const waiting = run([{ type: 'speech-start' }, { type: 'end-of-speech' }, { type: 'transcribed', take: 1, text: 'hi' }]).state
    expect(run([{ type: 'reply', spoken: null }], waiting).state.phase).toBe('listening')
    const listening = run([]).state
    expect(run([{ type: 'reply', spoken: null }], listening).effects).toEqual([])
  })

  it('an answer that comes while another is read is read next, never lost', () => {
    const speaking = run([{ type: 'reply', spoken: 'Old answer.' }]).state
    const held = run([{ type: 'reply', spoken: 'New answer.' }], speaking)
    expect(held.state.phase).toBe('speaking')
    expect(held.state.pending).toBe('New answer.')
    const next = run([{ type: 'speech-done' }], held.state)
    expect(next.state.phase).toBe('speaking')
    expect(next.state.lastSpoken).toBe('New answer.')
    expect(next.effects).toEqual(['speak'])
    expect(run([{ type: 'speech-done' }], next.state).state.phase).toBe('listening')
    // An answer that came while they talked: dropped once they send something new.
    const talking = run([{ type: 'speech-start' }, { type: 'reply', spoken: 'Stale.' }, { type: 'end-of-speech' }]).state
    expect(run([{ type: 'transcribed', take: talking.take, text: 'next question' }], talking).state.pending).toBeNull()
    // Only a cough: the answer is read.
    expect(run([{ type: 'transcribed', take: talking.take, text: '' }], talking).state.lastSpoken).toBe('Stale.')
  })

  it('a mic that does not open again pauses with its sentence', () => {
    const { state } = run([{ type: 'mic-failed', error: 'The microphone did not open: gone' }])
    expect(state.phase).toBe('paused')
    expect(state.error).toContain('did not open')
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
      { type: 'tap' }, { type: 'idle-timeout' }, { type: 'replay', spoken: 'x' }, { type: 'mic-failed', error: 'e' },
      { type: 'piece', spoken: 'x' }, { type: 'reply', spoken: 'x', streamed: true }, { type: 'reply', spoken: null, streamed: true },
      { type: 'run-stopped' },
    ]
    const base = openVoice().state
    for (const phase of ['listening', 'transcribing', 'waiting', 'speaking', 'paused'] as const) {
      for (const [heard, turn] of [[false, false], [true, false], [false, true], [true, true]] as const) {
        for (const e of events) {
          const step = reduceVoice({ ...base, phase, heard, turn }, e)
          expect(['listening', 'transcribing', 'waiting', 'speaking', 'paused']).toContain(step.state.phase)
        }
        // From any phase, a tap and at most one more event lead back to listening.
        const tapped = reduceVoice({ ...base, phase, heard, turn }, { type: 'tap' }).state
        const back = tapped.phase === 'listening' ? tapped : reduceVoice(tapped, { type: 'tap' }).state
        if (phase !== 'transcribing') expect(back.phase === 'listening' || back.phase === 'transcribing').toBe(true)
      }
    }
  })
})

/** Sent and waiting on the turn's answer. */
const sent = () => run([{ type: 'speech-start' }, { type: 'end-of-speech' }, { type: 'transcribed', take: 1, text: 'check the build' }]).state

describe('voice conversation: the answer read as it streams', () => {
  it('a send starts a turn; the first piece speaks at once; the next joins the queue', () => {
    const waiting = sent()
    expect(waiting.turn).toBe(true)
    const first = reduceVoice(waiting, { type: 'piece', spoken: 'Got it, checking the build.' })
    expect(first.state.phase).toBe('speaking')
    expect(first.effects).toEqual([{ type: 'enqueue', text: 'Got it, checking the build.' }])
    const second = reduceVoice(first.state, { type: 'piece', spoken: 'It is running.' })
    expect(second.state.phase).toBe('speaking')
    expect(second.effects).toEqual([{ type: 'enqueue', text: 'It is running.' }])
    // What is shown is the turn so far.
    expect(second.state.lastSpoken).toBe('Got it, checking the build. It is running.')
  })

  it('done speaking while the turn still works: back to waiting, not listening; the turn end then listens', () => {
    const speaking = run([{ type: 'piece', spoken: 'On it.' }], sent()).state
    const done = run([{ type: 'speech-done' }], speaking)
    expect(done.state.phase).toBe('waiting')
    expect(done.effects).toEqual([])
    // The turn ends with nothing more to say: listen.
    const ended = run([{ type: 'reply', spoken: null, streamed: true }], done.state)
    expect(ended.state.phase).toBe('listening')
    expect(ended.state.turn).toBe(false)
    expect(ended.effects).toEqual(['start-take'])
  })

  it('more pieces after a wait speak again, and the shown text keeps the whole turn', () => {
    const waitingAgain = run([{ type: 'piece', spoken: 'On it.' }, { type: 'speech-done' }], sent()).state
    const again = run([{ type: 'piece', spoken: 'The build passed.' }], waitingAgain)
    expect(again.state.phase).toBe('speaking')
    expect(again.effects).toEqual(['enqueue'])
    expect(again.state.lastSpoken).toBe('On it. The build passed.')
  })

  it('the turn end while speaking adds its last line and the drain then listens', () => {
    const speaking = run([{ type: 'piece', spoken: 'All done.' }], sent()).state
    const ended = reduceVoice(speaking, { type: 'reply', spoken: 'The rest is on screen.', streamed: true })
    expect(ended.state.phase).toBe('speaking')
    expect(ended.effects).toEqual([{ type: 'enqueue', text: 'The rest is on screen.' }])
    expect(ended.state.turn).toBe(false)
    expect(ended.state.lastSpoken).toBe('All done. The rest is on screen.')
    expect(run([{ type: 'speech-done' }], ended.state).state.phase).toBe('listening')
    // Nothing to add: it keeps saying what it says, then listens.
    const quiet = run([{ type: 'reply', spoken: null, streamed: true }], speaking)
    expect(quiet.effects).toEqual([])
    expect(run([{ type: 'speech-done' }], quiet.state).state.phase).toBe('listening')
  })

  it('the last line after a wait is said alone, then it listens', () => {
    const waitingAgain = run([{ type: 'piece', spoken: 'Done.' }, { type: 'speech-done' }], sent()).state
    const line = reduceVoice(waitingAgain, { type: 'reply', spoken: 'The rest is on screen.', streamed: true })
    expect(line.state.phase).toBe('speaking')
    expect(line.effects).toEqual([{ type: 'enqueue', text: 'The rest is on screen.' }])
    expect(run([{ type: 'speech-done' }], line.state).state.phase).toBe('listening')
  })

  it('Chinese pieces join with no space', () => {
    const zh1 = '\u597d\u7684\u3002'
    const zh2 = '\u6d4b\u8bd5\u901a\u8fc7\u4e86\u3002'
    expect(run([{ type: 'piece', spoken: zh1 }, { type: 'piece', spoken: zh2 }], sent()).state.lastSpoken).toBe(zh1 + zh2)
  })

  it('a piece never cuts in while the person talks or a take is transcribing', () => {
    const talking = run([{ type: 'speech-start' }]).state
    const dropped = run([{ type: 'piece', spoken: 'Hello.' }], talking)
    expect(dropped.state.phase).toBe('listening')
    expect(dropped.effects).toEqual([])
    expect(dropped.state.lastSpoken).toBeNull()
    const transcribing = run([{ type: 'speech-start' }, { type: 'end-of-speech' }]).state
    const held = run([{ type: 'piece', spoken: 'Hello.' }], transcribing)
    expect(held.state.phase).toBe('transcribing')
    expect(held.effects).toEqual([])
  })

  it('a piece of a turn the session started itself is read while the person is quiet, and marks the turn running', () => {
    const { state, effects } = run([{ type: 'piece', spoken: 'The build finished.' }])
    expect(state.phase).toBe('speaking')
    expect(state.turn).toBe(true)
    expect(effects).toEqual(['discard-take', 'enqueue'])
    expect(run([{ type: 'speech-done' }], state).state.phase).toBe('waiting')
  })

  it('paused keeps pieces for Replay only', () => {
    const paused = run([{ type: 'tap' }]).state
    const { state, effects } = run([{ type: 'piece', spoken: 'One.' }, { type: 'piece', spoken: 'Two.' }, { type: 'reply', spoken: 'The rest is on screen.', streamed: true }], paused)
    expect(state.phase).toBe('paused')
    expect(effects).toEqual([])
    expect(state.lastSpoken).toBe('One. Two. The rest is on screen.')
    expect(state.turn).toBe(false)
  })

  it('talking over a running turn stops the voice and mutes the rest of that turn', () => {
    const speaking = run([{ type: 'piece', spoken: 'Checking.' }], sent()).state
    const { state, effects } = run([{ type: 'barge-in' }], speaking)
    expect(effects).toEqual(['stop-speaking', 'mute-turn', 'start-take'])
    expect(state.phase).toBe('listening')
    // The tap does the same; with no turn running nothing is muted.
    expect(run([{ type: 'tap' }], speaking).effects).toEqual(['stop-speaking', 'mute-turn', 'start-take'])
    const replaying = run([{ type: 'reply', spoken: 'Old.' }]).state
    expect(run([{ type: 'barge-in' }], replaying).effects).toEqual(['stop-speaking', 'start-take'])
  })

  it('the bar Stop while the answer streams stops the voice and listens; while waiting it listens', () => {
    const speaking = run([{ type: 'piece', spoken: 'Checking.' }], sent()).state
    const stopped = run([{ type: 'run-stopped' }], speaking)
    expect(stopped.effects).toEqual(['stop-speaking', 'mute-turn', 'start-take'])
    expect(stopped.state.turn).toBe(false)
    const waiting = run([{ type: 'run-stopped' }], sent())
    expect(waiting.state.phase).toBe('listening')
    expect(waiting.effects).toEqual(['start-take'])
    // Its interrupted result that follows reads nothing.
    expect(run([{ type: 'reply', spoken: null }], waiting.state).effects).toEqual([])
  })

  it('a whole answer (nothing streamed) still works as before and ends the turn', () => {
    const { state, effects } = run([{ type: 'reply', spoken: 'Two meetings.' }, { type: 'speech-done' }], sent())
    expect(effects).toEqual(['speak', 'start-take'])
    expect(state.phase).toBe('listening')
    expect(state.turn).toBe(false)
  })

  it('a whole answer that comes while pieces play is read after them', () => {
    const speaking = run([{ type: 'piece', spoken: 'On it.' }], sent()).state
    const held = run([{ type: 'reply', spoken: 'The whole answer.' }], speaking)
    expect(held.state.pending).toBe('The whole answer.')
    const next = run([{ type: 'speech-done' }], held.state)
    expect(next.effects).toEqual(['speak'])
    expect(run([{ type: 'speech-done' }], next.state).state.phase).toBe('listening')
  })

  it('a new send starts a fresh turn text', () => {
    const afterFirst = run([{ type: 'piece', spoken: 'First turn.' }, { type: 'reply', spoken: null, streamed: true }, { type: 'speech-done' }], sent()).state
    expect(afterFirst.phase).toBe('listening')
    const second = run([{ type: 'speech-start' }, { type: 'end-of-speech' }, { type: 'transcribed', take: afterFirst.take, text: 'and then?' }, { type: 'piece', spoken: 'Second turn.' }], afterFirst).state
    expect(second.lastSpoken).toBe('Second turn.')
  })

  it('after talking over the voice, nothing starts speaking into the take the person asked for', () => {
    const speaking = run([{ type: 'piece', spoken: 'Checking.' }], sent()).state
    const listening = run([{ type: 'barge-in' }], speaking).state
    expect(listening.listenFirst).toBe(true)
    // A late piece and a whole answer: neither cuts in; the answer waits as pending.
    const piece = run([{ type: 'piece', spoken: 'Late.' }], listening)
    expect(piece.effects).toEqual([])
    expect(piece.state.phase).toBe('listening')
    const reply = run([{ type: 'reply', spoken: 'Whole answer.' }], listening)
    expect(reply.effects).toEqual([])
    expect(reply.state.pending).toBe('Whole answer.')
    // Only a cough came: the held answer is read, and the take is an ordinary one again.
    const cough = run([{ type: 'speech-start' }, { type: 'end-of-speech' }, { type: 'transcribed', take: reply.state.take, text: '' }], reply.state)
    expect(cough.state.phase).toBe('speaking')
    expect(cough.state.lastSpoken).toBe('Whole answer.')
  })

  it('a tap while it works (to say more) holds pieces back the same way', () => {
    const listening = run([{ type: 'tap' }], sent()).state
    expect(listening.listenFirst).toBe(true)
    expect(run([{ type: 'piece', spoken: 'Hi.' }], listening).effects).toEqual([])
    // A take that ends with words sends them, and the next answer is read again.
    const waiting = run([{ type: 'speech-start' }, { type: 'end-of-speech' }, { type: 'transcribed', take: listening.take, text: 'also this' }], listening).state
    expect(waiting.listenFirst).toBe(false)
    expect(run([{ type: 'piece', spoken: 'On it.' }], waiting).effects).toEqual(['enqueue'])
  })

  it('a result that ends only an older turn keeps waiting for the newer one', () => {
    const waiting = sent()
    const streamed = run([{ type: 'reply', spoken: null, streamed: true, continues: true }], waiting)
    expect(streamed.state.phase).toBe('waiting')
    expect(streamed.state.turn).toBe(true)
    expect(streamed.effects).toEqual([])
    const whole = run([{ type: 'reply', spoken: null, continues: true }], waiting)
    expect(whole.state.phase).toBe('waiting')
    // Said, then the voice runs out: back to waiting, since the newer turn still works.
    const said = run([{ type: 'reply', spoken: 'Old answer.', continues: true }, { type: 'speech-done' }], waiting)
    expect(said.state.phase).toBe('waiting')
  })
})
