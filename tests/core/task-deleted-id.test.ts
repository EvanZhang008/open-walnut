/**
 * Who a `task:deleted` event names (src/core/task-deleted-id.ts).
 *
 * The r5 gate's L-27: a merge sent its victim's delete as `{ task }` with no
 * `id`, and the board removes rows by `id`, so every other open window, the Mac
 * app included, kept the merged task until a reload. Pinned here:
 *  1. the board's reader takes the task's own id when `id` is missing;
 *  2. the companion still sends the primary a delete only for an event that
 *     names its `id`, and never for a merge's victim (a plain delete there
 *     would clear the session links the merge exists to keep);
 *  3. every `task:deleted` the server sends to the web UI names its `id`
 *     (a source scan: the bus's untyped overload compiles a missing field).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { companionDeleteId, deletedTaskId, mergedIntoOf, MERGE_EVENT_SOURCE } from '../../src/core/task-deleted-id.js'

describe('deletedTaskId', () => {
  it('reads the id, else the task id, else nothing', () => {
    expect(deletedTaskId({ id: 'a', task: { id: 'b' } })).toBe('a')
    expect(deletedTaskId({ task: { id: 'victim' } })).toBe('victim')
    expect(deletedTaskId({ id: '', task: { id: 'victim' } })).toBe('victim')
    expect(deletedTaskId({ id: 7, task: { id: 'victim' } })).toBe('victim')
    expect(deletedTaskId({ task: null })).toBeUndefined()
    expect(deletedTaskId({})).toBeUndefined()
    expect(deletedTaskId(undefined)).toBeUndefined()
    expect(deletedTaskId({ task: { id: '' } })).toBeUndefined()
  })
})

describe('mergedIntoOf', () => {
  it('reads the task a merge went into, and nothing for a plain delete (r6 gate, MED-1)', () => {
    expect(mergedIntoOf({ id: 'v', task: { id: 'v' }, mergedInto: { id: 's', title: 'Survivor' } })).toEqual({ id: 's', title: 'Survivor' })
    expect(mergedIntoOf({ id: 'v', mergedInto: { id: 's' } })).toEqual({ id: 's', title: '' })
    expect(mergedIntoOf({ id: 'v', task: { id: 'v' } })).toBeUndefined()
    expect(mergedIntoOf({ id: 'v', mergedInto: null })).toBeUndefined()
    expect(mergedIntoOf({ id: 'v', mergedInto: { id: '' } })).toBeUndefined()
    expect(mergedIntoOf({ id: 'v', mergedInto: { id: 7, title: 'x' } })).toBeUndefined()
    expect(mergedIntoOf(undefined)).toBeUndefined()
    expect(mergedIntoOf(null)).toBeUndefined()
  })
})

describe('companionDeleteId', () => {
  it('sends a delete only for an event that names its id', () => {
    expect(companionDeleteId({ source: 'api', data: { id: 't1', task: { id: 't1' } } })).toBe('t1')
    // As before: an event with the task alone is not sent (the plugin sync and the reconciler send those).
    expect(companionDeleteId({ source: 'marina-sync', data: { task: { id: 't1' } } })).toBeUndefined()
    expect(companionDeleteId({ source: 'api', data: undefined })).toBeUndefined()
  })

  it('never sends a merge victim as a plain delete', () => {
    expect(MERGE_EVENT_SOURCE).toBe('merge')
    expect(companionDeleteId({ source: MERGE_EVENT_SOURCE, data: { id: 'victim', task: { id: 'victim' } } })).toBeUndefined()
  })

  it('is what the companion outbox asks (a source check: the subscriber lives in startServer)', () => {
    const server = fs.readFileSync(path.resolve(__dirname, '../../src/web/server.ts'), 'utf8')
    const outbox = server.slice(server.indexOf("bus.subscribe('task-outbox'"))
    expect(outbox.length).toBeLessThan(server.length)
    const deletes = outbox.slice(0, outbox.indexOf('EventNames.TASK_CREATED'))
    expect(deletes).toContain('companionDeleteId(event)')
    expect(deletes).not.toMatch(/dispatchTaskOp\(\{ type: 'delete', id: data\.id/)
  })
})

describe('every task:deleted sent to the web UI names its id', () => {
  const SRC = path.resolve(__dirname, '../../src')
  function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return files(full)
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : []
    })
  }
  // bus.emit(EventNames.TASK_DELETED, { ...payload }, [destinations], ...)
  const EMIT = /bus\.emit\(\s*EventNames\.TASK_DELETED\s*,\s*\{([^}]*)\}\s*,\s*\[([^\]]*)\]/g

  // Every emit of the event at all, however its payload is written.
  const ANY_EMIT = /bus\.emit\(\s*(EventNames\.TASK_DELETED|'task:deleted'|"task:deleted")/g

  it('holds for every emitter, the merge included', () => {
    const toWeb: string[] = []
    const missing: string[] = []
    const unread: string[] = []
    for (const file of files(SRC)) {
      const text = fs.readFileSync(file, 'utf8')
      const parsed = [...text.matchAll(EMIT)].length
      const all = [...text.matchAll(ANY_EMIT)].length
      // A payload this scan cannot read (nested braces, a variable, the string name) fails it.
      if (all !== parsed) unread.push(`${path.relative(SRC, file)}: ${all} emits, ${parsed} read`)
      for (const m of text.matchAll(EMIT)) {
        const [, payload, destinations] = m
        if (!/'web-ui'|'\*'/.test(destinations!)) continue
        const where = `${path.relative(SRC, file)}:${text.slice(0, m.index).split('\n').length}`
        toWeb.push(where)
        if (!/(^|[,{\s])id\s*:/.test(payload!)) missing.push(`${where}: { ${payload!.trim()} }`)
      }
    }
    expect(unread).toEqual([])
    expect(missing).toEqual([])
    // The scan sees the emitters (it would pass on none): the merge's among them.
    expect(toWeb.some((w) => w.startsWith('core/task-manager.ts:')), toWeb.join('\n')).toBe(true)
    expect(toWeb.length, toWeb.join('\n')).toBeGreaterThanOrEqual(8)
  })
})
