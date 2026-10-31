/**
 * Whom a send went to (src/lib/send-targets.ts), on the shapes a lead's real sends
 * take (2026-10-30, the user, of a "Sent 2" fold whose card said "To another
 * session": which session?). Neutral ids; the shapes are the real ones.
 */
import { describe, it, expect } from 'vitest'
import { commandTargetRefs, resultTargetRefs, sendTargetRefs } from '../../src/lib/send-targets'

describe('sendTargetRefs', () => {
  it('inline arguments name the target', () => {
    const cmd = `walnut tools call task_send '{"to":"abcd1234-ef56","title":"Hi","text":"..."}'`
    expect(commandTargetRefs(cmd)).toEqual(['abcd1234-ef56'])
    expect(sendTargetRefs(undefined, cmd, 'Message delivered on this host to abcd1234-ef56. A')).toEqual(['abcd1234-ef56'])
  })

  it('arguments built in a subshell leave only the answer, cut short', () => {
    const cmd = `walnut tools call task_send "$(python3 -c 'import json;print(json.dumps({"to":X}))')" | cut -c1-60`
    expect(commandTargetRefs(cmd)).toEqual([])
    expect(sendTargetRefs(undefined, cmd, 'Message delivered on this host to abcd1234-ef')).toEqual(['abcd1234-ef'])
  })

  it('a Python dict with escaped quotes inside the subshell still names it', () => {
    const cmd = `walnut tools call task_send "$(python3 -c 'import json;print(json.dumps({\\"to\\":\\"abcd1234-ef56\\",\\"title\\":\\"x\\"}))')"`
    expect(commandTargetRefs(cmd)).toEqual(['abcd1234-ef56'])
  })

  it('a loop over two tasks is one call with two targets; the shell variable is not one', () => {
    const cmd = `for id in abcd1234-ef56 99887766-5544; do walnut tools call task_send "{\\"to\\":\\"$id\\"}"; done`
    expect(commandTargetRefs(cmd)).toEqual([])
    const result = 'Message delivered on this host to abcd12\nMessage delivered on this host to 998877'
    expect(sendTargetRefs(undefined, cmd, result)).toEqual(['abcd12', '998877'])
  })

  it('the JSON answer and the queued form', () => {
    expect(resultTargetRefs('{"outcome":"Message queued for zzzz9999-0001. Accepted","targetTaskId":"zzzz9999-0001"}')).toEqual(['zzzz9999-0001'])
    expect(sendTargetRefs({ to: 'zzzz9999' }, undefined, '{"targetTaskId":"zzzz9999-0001"}')).toEqual(['zzzz9999-0001'])
    expect(resultTargetRefs('{"target":{"handle":"Docs [aaaa]","taskId":"tttt0000-1111"}}')).toEqual(['tttt0000-1111'])
    expect(resultTargetRefs('Reply delivered on this host to the asking session (tttt0000-1111). Do NOT resend.')).toEqual(['tttt0000-1111'])
  })

  it('one send is one target, however the arguments named it (review 2026-10-30)', () => {
    // Parked on a permission prompt: the outcome line names the session, the JSON the task.
    const parked = '{"delivery":"deferred","targetTaskId":"tttt0000-1111","targetSessionId":"5e55a000-0000-4000-8000-000000000001","outcome":"Message queued for 5e55a000-0000-4000-8000-000000000001: it is parked on a human permission prompt"}'
    expect(sendTargetRefs({ to: 'tttt0000-1111' }, undefined, parked)).toEqual(['tttt0000-1111'])
    // Sent by session id or by a hyphenated handle: the answer's task id alone counts.
    expect(sendTargetRefs({ to: '5e55a000-0000-4000-8000-000000000001' }, undefined, 'Message queued for tttt0000-1111. Accepted')).toEqual(['tttt0000-1111'])
    expect(sendTargetRefs({ to: 'docs-lead' }, undefined, '{"targetTaskId":"tttt0000-1111"}')).toEqual(['tttt0000-1111'])
    // No answer yet: the arguments.
    expect(sendTargetRefs({ to: 'docs-lead' }, undefined, undefined)).toEqual(['docs-lead'])
  })

  it('a name or a too-short word is never a target', () => {
    expect(sendTargetRefs({ to: 'Docs lead' }, undefined, 'Message queued for Docs lead. Do NOT resend.')).toEqual([])
    expect(sendTargetRefs({ to: 'ab12' }, undefined, undefined)).toEqual([])
    expect(resultTargetRefs('Message queued for Walnut lead. Do NOT resend.')).toEqual([])
    expect(sendTargetRefs(undefined, undefined, undefined)).toEqual([])
  })
})
