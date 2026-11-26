/**
 * An error class says what it is: a refusal a caller can fix carries a `status` and a `code`
 * (src/lib/coded-refusal.ts), and every door then answers it under that code. A class with
 * neither reaches a client as 500 `internal`, the server's own fault, unless a route names it.
 *
 * 2026-11-26: ContentValidationError (a sync plugin's content rule refusing a task's text) had
 * neither and no route named it, so a task_update read `internal` and real use counted a thrown
 * error. The classes of the task manager all carry their answer now; the ones elsewhere that
 * carry none are listed in uncoded-error-classes.json (faults, and classes their own routes
 * answer), and a NEW class must be one or the other on purpose.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanErrorClasses, uncodedErrorClasses } from '../helpers/error-classes.js'
import { codedRefusalOf, refusal } from '../../src/lib/coded-refusal.js'

const ROOT = path.resolve(__dirname, '../..')
const LISTED = JSON.parse(fs.readFileSync(path.join(__dirname, 'uncoded-error-classes.json'), 'utf8')) as string[]

describe('an error class is a coded refusal or a listed fault', () => {
  const classes = scanErrorClasses(ROOT)

  it('finds the classes', () => {
    expect(classes.length).toBeGreaterThan(300)
    expect(classes.filter((c) => c.coded).length).toBeGreaterThan(60)
  })

  it('no new class without a status and a code', () => {
    const left = [...LISTED]
    const fresh = uncodedErrorClasses(ROOT).filter((name) => {
      const at = left.indexOf(name)
      if (at === -1) return true
      left.splice(at, 1)
      return false
    })
    expect(fresh, 'a refusal a caller can fix carries a 4xx status and a code (src/lib/coded-refusal.ts); a fault, or a class its own route answers, goes in tests/core/uncoded-error-classes.json').toEqual([])
    expect(left, 'listed in tests/core/uncoded-error-classes.json but no longer declared without a code: take it off the list').toEqual([])
  })

  it('every class the task manager throws carries its answer', () => {
    const own = classes.filter((c) => c.file === 'src/core/task-manager.ts')
    expect(own.length).toBeGreaterThanOrEqual(10)
    expect(own.filter((c) => !c.coded).map((c) => c.name)).toEqual([])
  })
})

describe('what counts as a coded refusal', () => {
  it('a 4xx status (or 501) and a code in Walnut\'s own form', () => {
    expect(codedRefusalOf(refusal('content_rule', 'no', 422))).toEqual({ status: 422, code: 'content_rule', message: 'no' })
    expect(codedRefusalOf(refusal('bad_input', 'no'))).toMatchObject({ status: 400 })
    expect(codedRefusalOf(refusal('not_supported_cloud', 'no', 501))).toMatchObject({ status: 501 })
  })

  it.each([
    ['a plain error', new Error('boom')],
    ['a server fault with a code', Object.assign(new Error('boom'), { status: 500, code: 'internal' })],
    ['a status alone (a body parser\'s)', Object.assign(new Error('too large'), { status: 413, type: 'entity.too.large' })],
    ['a system call\'s code', Object.assign(new Error('gone'), { status: 404, code: 'ENOENT' })],
    ['an HTTP client\'s code', Object.assign(new Error('bad'), { status: 400, code: 'ERR_BAD_REQUEST' })],
    ['a code alone', Object.assign(new Error('x'), { code: 'conflict' })],
    ['what is no error', { status: 400, code: 'bad_input', message: 'x' }],
  ])('%s is not one', (_name, err) => {
    expect(codedRefusalOf(err)).toBeNull()
  })
})
