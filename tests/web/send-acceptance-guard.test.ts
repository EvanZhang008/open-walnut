/**
 * The class of F3 (2026-11-11 review): a composer decided on its own what a
 * failed `session:send` meant, so a send whose answer was lost while the server
 * kept the message kept its words (Enter sent them twice) and its red line. One
 * rule decides acceptance now (web/src/api/session-send.ts), and every composer
 * reads it. These checks enumerate the send sites and the composers from the
 * source, so a new one fails here until it goes through the rule.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const WEB = path.join(ROOT, 'web/src')
const rel = (f: string) => path.relative(ROOT, f)
const read = (f: string) => fs.readFileSync(path.isAbsolute(f) ? f : path.join(ROOT, f), 'utf8')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...walk(p)) }
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p)
  }
  return out
}
const FILES = walk(WEB)
const RULE = 'web/src/api/session-send.ts'

describe('one rule decides that a send was accepted', () => {
  it('the session:send RPC is made in one place, the acceptance rule', () => {
    const sites = FILES.filter((f) => /sendRpc\s*(<[^>]*>)?\s*\(\s*['"]session:send['"]/.test(read(f))).map(rel)
    expect(sites, 'send through sendSessionMessage (api/session-send.ts), which reads a lost answer from the server\'s record').toEqual([RULE])
    // Nor by a method name kept in a variable.
    const named = FILES.filter((f) => rel(f) !== RULE && /['"]session:send['"]/.test(read(f).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''))).map(rel)
    expect(named).toEqual([])
  })

  it('the rule stands a lost answer in with the server\'s record of the send\'s user line', () => {
    const src = read(RULE)
    expect(src).toMatch(/const row = await confirmKept\(payload\.sessionId, userUuid\);\n\s*if \(!row\) throw e;/)
    expect(src).toMatch(/wsClient\.onEvent\('session:message-queued'/)
    // The server names that line on the queued event (an older server: the queue read still finds it).
    expect(read('src/core/session-message-queue.ts')).toMatch(/\.\.\.\(msg\.userUuid \? \{ userUuid: msg\.userUuid \} : \{\}\),\n\s*enqueuedAt: msg\.enqueuedAt,/)
  })

  it('every send of the composer hook goes through it and names its user line', () => {
    const hook = read('web/src/hooks/useSessionSend.ts')
    expect(hook.match(/\bsendSessionMessage\(/g)?.length).toBe(3) // send, interruptSend, retryFailed
    // Every send gets a line, so a lost answer is known by it (an engine switch excepted).
    expect(hook).toMatch(/function withOwnedUuid[\s\S]*?const userUuid = opts\?\.userUuid \?\? newUserUuid\(\);/)
    // Late proofs accept a refused bubble and settle the composer it was restored to.
    expect(hook).toMatch(/onKept\(\(row\) => \{[\s\S]*?settleRetriedDraft\(m\.draftOrigin\)/)
    expect(hook).toMatch(/settleShownInHistory = useCallback[\s\S]*?settleRetriedDraft\(m\.draftOrigin\)/)
  })

  it('the red line is about its send and goes when that send is accepted', () => {
    const hook = read('web/src/hooks/useSessionSend.ts')
    expect(hook).toMatch(/sendError: shownSendError\(sendErrorState, optimisticMsgs\),/)
    // A send's own failure names its line; only sendless errors (an upload, a Stop, a batch) do not.
    const failures = [...hook.matchAll(/setSendError\(([a-z]+)\.message(, [^)]+)?\)/g)]
    expect(failures.length).toBeGreaterThanOrEqual(3)
    for (const f of failures) expect(f[0], 'a send\'s failure names its user line').toMatch(/, (opts\?\.userUuid|failedMsg\.userUuid)\)/)
  })
})

/**
 * Every composer that puts refused words back in its box (claimFailedDraft) must
 * also empty when that send is accepted later: by subscribing to the settle
 * (onDraftSettled) itself, or by keeping its words in useDraft, which does.
 */
const RESTORING_COMPOSERS: Record<string, string> = {
  'web/src/components/chat/ChatInput.tsx': 'onDraftSettled',
  'web/src/components/sessions/ThreadCommentCard.tsx': 'useDraft',
}

describe('every composer that keeps refused words lets them go once the send is accepted', () => {
  it('lists every composer that restores a refused send', () => {
    const found = FILES.filter((f) => /\bclaimFailedDraft\(/.test(read(f))).map(rel).filter((f) => f !== 'web/src/utils/drafts.ts').sort()
    expect(found, 'a new composer that restores refused words: subscribe to onDraftSettled (or keep its words in useDraft) and list it').toEqual(Object.keys(RESTORING_COMPOSERS).sort())
  })

  it.each(Object.entries(RESTORING_COMPOSERS))('%s empties on the settle (%s)', (file, how) => {
    const src = read(file)
    if (how === 'useDraft') {
      expect(src).toMatch(/\buseDraft\(/)
      expect(read('web/src/hooks/useDraft.ts')).toMatch(/onDraftSettled\(\(origin\) => \{[\s\S]*?setTextState\(baselineRef\.current\)/)
    } else {
      expect(src).toMatch(/onDraftSettled\(\(origin\) => \{[\s\S]*?applyText\(''/)
    }
  })

  it('every component on the composer hook reads its boolean, never a raw error', () => {
    // A box that awaits `send` gets true for a lost answer the server kept: no file catches the
    // RPC itself to decide (the first check), and none reads the hook's error to keep its words.
    const users = FILES.filter((f) => /\buseSessionSend\(/.test(read(f))).map(rel)
    expect(users.length).toBeGreaterThan(5)
    for (const f of users) expect(read(f), f).not.toMatch(/sendError\s*\?\s*[^:]*setText\(/)
  })
})
