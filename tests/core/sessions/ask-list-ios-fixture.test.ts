/**
 * The phone's asks decoder is tested on a list THIS module produced.
 *
 * `tests/fixtures/ask-list/board.json` is an invented board; this test runs the
 * real `buildAskList` over it and pins `expected.json`, the exact GET
 * /api/v1/asks answer for that board. ios-native/WalnutTests/AskListDecodingTests.swift
 * decodes `expected.json` and asserts the phone keeps its order, titles and
 * states. A hand-written expected list would only prove the phone agrees with
 * its author; this way a rule change on the server fails here until the fixture
 * is regenerated, and the phone's test then runs against the new answer.
 *
 * Regenerate: WALNUT_WRITE_ASK_FIXTURE=1 ./node_modules/.bin/vitest run <this file>
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildAskList, type AskListAgent, type AskTaskLike } from '../../../src/core/sessions/ask-list.js'

const dir = path.resolve(import.meta.dirname, '../../fixtures/ask-list')

function answer(): unknown {
  const board = JSON.parse(readFileSync(path.join(dir, 'board.json'), 'utf8')) as { agent: AskListAgent; tasks: AskTaskLike[] }
  const { total, asks } = buildAskList(board.tasks, board.agent)
  // Same keys, same order as computeAgentAsks answers (`launch` is the primary's
  // own flag, always true on a server that has this module).
  return { agentId: board.agent.id, project: board.agent.project, total, launch: true, asks }
}

/** JSON with every non-ASCII character escaped, so the fixture stays ASCII. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n'
}

describe('asks-list fixture shared with the phone', () => {
  it('expected.json is exactly buildAskList(board.json)', () => {
    if (process.env.WALNUT_WRITE_ASK_FIXTURE === '1') writeFileSync(path.join(dir, 'expected.json'), asciiJson(answer()))
    const pinned = JSON.parse(readFileSync(path.join(dir, 'expected.json'), 'utf8'))
    expect(pinned).toEqual(answer())
  })
})
