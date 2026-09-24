/**
 * The masking and budget rules behind the three preview fields a phone renders
 * (`detail`, `inputPreview`, `resultPreview` — src/core/tool-summary.ts).
 *
 * Why these live in their own file: the projection and HTTP tests pin the WIRING
 * (which row carries which field, on which read). This pins the CONTENT rule, and a
 * content rule is only worth what its adversarial cases are worth. Every case below
 * is a probe an independent review ran against the shipped code, kept as a test so
 * the next change to the masker has to answer it:
 *
 *  - shapes that leaked and now must not (JSON-nested secrets, a lowercase PEM
 *    marker, a spaced JSON pair)
 *  - shapes that STILL leak, kept as executable documentation of the limit rather
 *    than a comment nobody re-checks
 *  - ordinary code and prose that must come through untouched: these fields are
 *    read by a human, so a false positive is a defect, not a harmless precaution
 *  - the two budgets, one of which (`INPUT_PREVIEW_VALUE_MAX`) had a green test
 *    that held for the wrong reason
 */
import { describe, it, expect } from 'vitest'
import {
  toolDetail, toolInputPreview, toolResultPreview, thinkingLine, thinkingExcerpt,
  thinkingFullText, toolInputFullText, toolResultFullText,
  thinkingHasFullText, toolHasFullText, sectionHasMore, FULL_TEXT_SECTION_MAX,
} from '../../src/core/tool-summary.js'

/** A PEM body long enough to look like real key material. */
const PEM_BODY = 'MIIEow'.repeat(600)

describe('preview masking: secrets that must not reach a phone', () => {
  it('masks a secret nested inside a JSON-rendered tool input', () => {
    // toolInputPreview renders a non-string value with JSON.stringify, so the pair
    // arrives as `"api_key":"…"` — a shape every `key=value` pattern misses because
    // a quote sits between the key and the colon. Tool inputs are objects, so this
    // is the COMMON case for a credential here, not an exotic one.
    expect(toolInputPreview({ args: { api_key: 'liveKeyValue123456' } }))
      .toBe('args: {"api_key":"[REDACTED]"}')
    expect(toolInputPreview({ headers: { token: 'abc123hunter2' } }))
      .toBe('headers: {"token":"[REDACTED]"}')
    expect(toolInputPreview({ body: { password: 'p@ssw0rd-real' } }))
      .toBe('body: {"password":"[REDACTED]"}')
    // Authorization only ever appears as a JSON/header key, never as `authorization=`.
    expect(toolInputPreview({ headers: { Authorization: 'Basic ZGV2OnMzY3JldA==' } }))
      .toBe('headers: {"Authorization":"[REDACTED]"}')
    // Inside an array, one level deeper.
    expect(toolInputPreview({ env: [{ secret: 'realSecretHere' }] }))
      .toBe('env: [{"secret":"[REDACTED]"}]')
  })

  it('masks a private key block whose marker is lowercase', () => {
    const out = toolResultPreview('-----begin rsa private key-----\n' + PEM_BODY)!
    expect(out).not.toContain('MIIEow')
    expect(out).toContain('[REDACTED]')
  })

  it('masks a private key block in every framing, complete or truncated', () => {
    // Complete blocks: the masker's own pattern. CRLF, one line, and short bodies.
    expect(toolResultPreview('head\r\n-----BEGIN RSA PRIVATE KEY-----\r\n' + PEM_BODY + '\r\n-----END RSA PRIVATE KEY-----'))
      .toBe('head\r\n[REDACTED]')
    expect(toolResultPreview('head -----BEGIN OPENSSH PRIVATE KEY----- ' + PEM_BODY + ' -----END OPENSSH PRIVATE KEY-----'))
      .toBe('head [REDACTED]')
    expect(toolResultPreview('-----BEGIN PRIVATE KEY-----\nSHORTBODY\n-----END PRIVATE KEY-----'))
      .toBe('[REDACTED]')
    // Truncated: a real key runs for KBs, so its END marker sits outside the
    // bounded window the masker sees and the block pattern cannot match. The
    // backstop cuts from the opener instead.
    expect(toolDetail('Bash', { description: '-----BEGIN EC PRIVATE KEY-----\n' + PEM_BODY }))
      .toBe('[REDACTED]')
  })

  it('masks the flat pair shapes, in every separator style a tool emits', () => {
    expect(toolInputPreview({ api_key: 'liveKeyValue123456' })).toBe('api_key: [REDACTED]')
    expect(toolResultPreview('a\r\ntoken=realSecret123\r\nb')).toBe('a\r\ntoken=[REDACTED]\r\nb')
    expect(toolResultPreview('token: realSecret123')).toBe('token: [REDACTED]')
    expect(toolResultPreview('export GITHUB_TOKEN=ghp_realSecretValue123'))
      .toBe('export GITHUB_TOKEN=[REDACTED]')
    // Spaces around the JSON colon (a pretty-printed body).
    expect(toolResultPreview('{ "token" : "realSecret123" }')).toBe('{ "token" : "[REDACTED]" }')
  })

  it('masks a secret that only becomes visible after an earlier mask shrank the text', () => {
    // Masking runs before the cap because a mask can GROW text. It can also SHRINK
    // it, pulling later content inside the final cut — so every pattern has to have
    // run over that content too, not just the part that fit before the shrink. The
    // Bearer rule (which shrinks ~600 chars here) runs BEFORE the `sk-` rule, so
    // this is the ordering that could hide a secret from a later pattern.
    const pre = 'x'.repeat(50) + ' Bearer ' + 'B'.repeat(600) + ' '
    const key = 'sk-live-' + 'K'.repeat(40)
    const out = toolResultPreview(pre + 'y'.repeat(710 - pre.length) + ` ${key} tail`)!
    expect(out).not.toContain(key)
    expect(out).toContain('Bearer [REDACTED]')
  })

  it('masks an all-uppercase bearer token (the shape a case-folded guard let through)', () => {
    // Regression: the "value is not one word" guard was first written with the `i`
    // flag, under which `[a-z]` matches `B` — so 60 uppercase characters read as a
    // single lowercase word and shipped in full.
    expect(toolResultPreview('Authorization: Bearer ' + 'B'.repeat(60)))
      .toBe('Authorization: Bearer [REDACTED]')
    expect(toolResultPreview('Bearer AbCdEf12345678')).toBe('Bearer [REDACTED]')
    // Short enough to BE a word by length — only its case says otherwise, which is
    // exactly what a case-folded guard cannot see.
    expect(toolResultPreview('Bearer SECRETVALUEXYZ')).toBe('Bearer [REDACTED]')
  })

  it('masks a short non-word value (the shape a length floor let through)', () => {
    // A 4-digit password is a weak secret, not prose. A plain "value ≥6 chars" rule
    // exempted it; the shape rule masks it and still leaves prose alone.
    expect(toolResultPreview('password=1234')).toBe('password=[REDACTED]')
    expect(toolResultPreview('token=abc123')).toBe('token=[REDACTED]')
    // Uppercase is not a word here either, for the same case-sensitivity reason.
    expect(toolResultPreview('token=ABCDE')).toBe('token=[REDACTED]')
  })
})

describe('preview masking: limits that are documented, not fixed', () => {
  it('can leave a PARTIAL secret when the redaction window or a value clip splits it', () => {
    // The masker only ever sees `cap + slack` characters, and a value is clipped to
    // 1000 before the lines are joined. A secret cut by either boundary is below its
    // pattern's minimum length, so no rule matches the surviving head.
    //
    // Accepted rather than fixed: closing it means masking the WHOLE source string
    // (unbounded regex work on a per-row, per-transcript-read path — the thing the
    // bounded window exists to prevent). What survives is a prefix of 7-19
    // characters, which is unusable as a credential on its own.
    const filler = 'a'.repeat(200)
    const shrinker = 'token=' + 'S'.repeat(500)
    const pre = filler + '\n' + shrinker + '\n'
    const straddle = toolResultPreview(pre + 'b'.repeat(956 - pre.length - 25) + 'sk-' + 'K'.repeat(60))!
    expect(straddle).toContain('token=[REDACTED]')      // the in-window secret IS masked
    expect(straddle).toContain('sk-KKKK')               // the straddling one is not
    expect(straddle).not.toContain('sk-' + 'K'.repeat(30)) // ...and only a stub survives

    const clipped = toolInputPreview({ command: 'q'.repeat(990) + 'sk-' + 'Z'.repeat(60) })!
    expect(clipped).toContain('sk-Z')
    expect(clipped).not.toContain('sk-' + 'Z'.repeat(30))
  })

  it('cannot mask key material with no marker, or a pair with no recognised key name', () => {
    // Inherent to pattern matching: with no `-----BEGIN` marker, a base64 blob is
    // indistinguishable from any other base64 blob; with no known key name,
    // `SESSION_KEY=` is indistinguishable from `WIDTH=`. Both are recorded here so
    // the next person meeting one knows it is a known shape, not a new bug.
    expect(toolResultPreview('MIIEvgIBADANBg' + 'k'.repeat(300))).toContain('MIIEvgIBADANBg')
    expect(toolResultPreview('DB_URL=postgres://u:p@h/db\nSESSION_KEY=abcdef123456'))
      .toContain('abcdef123456')
  })
})

describe('preview masking: ordinary content survives untouched', () => {
  // These fields are read by a HUMAN, so a false positive is a defect. Every case
  // here was a measured mangling before the value-shape constraints landed.
  const untouched: Array<[string, string]> = [
    ['prose that says "bearer"', 'Fix the bearer auth header parsing'],
    ['prose after "bearer" that IS one long word', 'Bearer authentication is required here'],
    ['a markdown heading', '## Secret: keep the design quiet'],
    ['a prose gloss after a colon', 'Design note\ntoken: an opaque handle\nsee docs'],
    ['source code reading a secret', "const password = form.get('password')"],
    ['a URL with a path that looks like userinfo', 'see https://example.test/a:b@c'],
    ['a short filler value', 'token: N/A'],
  ]
  for (const [label, text] of untouched) {
    it(`leaves ${label} byte-identical`, () => {
      expect(toolResultPreview(text)).toBe(text)
    })
  }

  it('leaves a grep PATTERN that looks like a secret assignment alone', () => {
    expect(toolDetail('Grep', { pattern: 'token=\\w+' })).toBe('token=\\w+')
    expect(toolDetail('Bash', { description: 'Fix the bearer auth header parsing' }))
      .toBe('Fix the bearer auth header parsing')
  })

  it('does not truncate a grep hit that merely CONTAINS a private-key marker', () => {
    // The truncating backstop requires ≥40 base64 characters after the marker,
    // because the ordinary way a developer meets those words is a search result.
    // Requiring only the marker cut this preview at "matches:" and threw the answer
    // away — the tool call then reported nothing at all.
    const grepHit = 'matches:\n-----BEGIN RSA PRIVATE KEY-----\nfound in 3 files\nnext line'
    expect(toolResultPreview(grepHit)).toBe(grepHit)
  })
})

describe('preview budgets', () => {
  it('keeps the small keys visible when a fat value comes FIRST', () => {
    // The per-value clip is what makes this work, and the ORDER matters: with
    // `file_path` first it survives the joined cap either way, so a test written
    // that way stays green with the clip removed. This is the same "unreachable at
    // any expansion level" defect the field exists to fix, moved one key over.
    const out = toolInputPreview({ content: 'y'.repeat(50_000), file_path: '/tmp/marina/notes.md' })!
    expect(out).toContain('file_path: /tmp/marina/notes.md')
    expect(out.length).toBeLessThanOrEqual(2001)
  })

  it('renders a small structured value exactly as JSON.stringify would', () => {
    // The budgeted serializer must be a no-op below its budget. If its per-node
    // cost were mis-sized, ordinary tool inputs would silently lose keys.
    const value = { a: 1, b: [1, 2, 'three'], c: { d: true, e: null } }
    expect(toolInputPreview({ meta: value })).toBe(`meta: ${JSON.stringify(value)}`)
    expect(toolInputPreview({ meta: value })).not.toContain('…')
    // `toJSON()` too, or a Date renders as `{}` instead of its timestamp.
    const dated = { at: new Date('2026-01-02T03:04:05.000Z') }
    expect(toolInputPreview({ meta: dated })).toBe(`meta: ${JSON.stringify(dated)}`)
  })

  it('survives a reference cycle instead of hanging on it', () => {
    // Every level of the walk spends budget, so a cycle bottoms out. Without that,
    // a self-referencing input (rare, but it only has to happen once) would spin
    // the event loop the whole server shares.
    const looped: Record<string, unknown> = { name: 'loop' }
    looped.self = looped
    const out = toolInputPreview({ arg: looped })!
    expect(out.startsWith('arg: {"name":"loop"')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(2001)
  })

  it('bounds a huge array without rendering it as a run of nulls', () => {
    // A replacer that prunes array ELEMENTS emits `null` for each one, so a 100k
    // array would come back as a sea of nulls that fills the whole budget. Long
    // arrays are sliced instead.
    const out = toolInputPreview({ edits: Array.from({ length: 100_000 }, (_, i) => ({ i })) })!
    expect(out).not.toContain('null')
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(2001)
  })

  it('folds only the head of a huge thinking block, and gets the same answer', () => {
    // thinkingLine folds whitespace out of a PREFIX rather than the whole block (a
    // `/\s+/g` pass over 2 MB measured 7.56 ms, per row, per transcript read). The
    // risk of that is a DIFFERENT answer, so pin equivalence against a full fold —
    // with a whitespace-heavy head, where the first window comes up short and the
    // widening loop has to run.
    const heavy = ' \n\t'.repeat(400) + 'The user is asking about the deploy script. '.repeat(200)
    const fullFold = heavy.replace(/\s+/g, ' ').trim()
    expect(thinkingLine(heavy)).toBe(fullFold.slice(0, 160) + '…')

    // Short input: folded, trimmed, no ellipsis. And the exact boundary.
    expect(thinkingLine('  a\n\n b  ')).toBe('a b')
    expect(thinkingLine('z'.repeat(160))).toBe('z'.repeat(160))
    expect(thinkingLine('z'.repeat(161))).toBe('z'.repeat(160) + '…')
  })

  it('folds only the head of a huge tool description, and gets the same answer', () => {
    const heavy = '\n\n'.repeat(300) + 'Deploy the staging stack and watch the logs. '.repeat(100)
    const fullFold = heavy.replace(/\s+/g, ' ').trim()
    expect(toolDetail('Bash', { description: heavy })).toBe(fullFold.slice(0, 160) + '…')
  })
})

/**
 * The FULL-text read behind an expanded row (the drawer). It exists because the
 * excerpts above must stay excerpts — they ride a page the phone refetches at every
 * turn end — while a drawer that opens to "see everything" must not drop the tail.
 *
 * The rule that matters here is that widening the window does not widen what
 * escapes: a longer read is a longer masked read.
 */
describe('full-text read: the same masking rule at 100x the length', () => {
  it('masks a secret that sits far past the preview cap', () => {
    // The load-bearing case. The credential is ~3 KB into the output, so the
    // 700-character `resultPreview` never contained it and could not have masked it.
    // If the full read shipped raw text, this is the byte where a drawer would start
    // leaking credentials that no surface leaked before.
    const testSecret = 'aws_secret_access_key=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY'
    const result = 'ordinary build output line\n'.repeat(120)
      + `${testSecret}\n`
      + 'and the build continues\n'.repeat(120)
    // Past 700 (resultPreview) AND past 2000 (the widest excerpt any field carries),
    // so no preview masker has ever seen these bytes.
    expect(result.indexOf(testSecret)).toBeGreaterThan(2_000)
    const preview = toolResultPreview(result)!
    expect(preview).not.toContain('wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY')
    expect(preview.length).toBeLessThanOrEqual(701) // it never even got there

    const full = toolResultFullText(result)!
    expect(full.text).toContain('[REDACTED]')
    expect(full.text).not.toContain('wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY')
    // Masked, not truncated: the output around the credential is all there.
    expect(full.text).toContain('and the build continues')
    // The total counts what was DELIVERED, so it is the masked length — below the
    // source, because `[REDACTED]` is shorter than the key it replaced. Reporting the
    // source here made a complete result look 28 characters short of itself.
    expect(full.totalChars).toBe(full.text.length)
    expect(full.totalChars).toBeLessThan(result.trim().length)
    expect(sectionHasMore(full)).toBe(false)
    expect(full.nextOffset).toBeUndefined()
  })

  it('masks a secret in a tool input value the preview clipped away', () => {
    // Same shape one field over: the fat first value pushes the credential past the
    // per-value clip, so only the full read ever sees it.
    const input = {
      command: 'run --step build '.repeat(80) + 'export API_TOKEN=aws_session_token=zzTOPSECRETzz',
      description: 'Build',
    }
    expect(toolInputPreview(input)).not.toContain('zzTOPSECRETzz')
    const full = toolInputFullText(input)!
    expect(full.text).toContain('[REDACTED]')
    expect(full.text).not.toContain('zzTOPSECRETzz')
    // The whole input, in the input's own key order — the per-value cap that hides a
    // later key on the collapsed card is deliberately not applied here.
    expect(full.text).toContain('description: Build')
  })

  it('masks reasoning at both lengths, so the excerpt is not the one field left raw', () => {
    // thinkingText used to be the single unmasked field of the four. Reasoning is not
    // a safer source than a tool input: the model quotes what it just read.
    const reasoning = 'The config says password=hunter2hunter2 so I will use it.\n'
      + 'Then I will deploy. '.repeat(200)
      + 'aws_secret_access_key=zzREASONINGSECRETzz'
    // One secret inside the excerpt's window, one PAST it — the second is the case
    // that only exists because of the full read.
    expect(reasoning.indexOf('zzREASONINGSECRETzz')).toBeGreaterThan(2_000)
    expect(thinkingExcerpt(reasoning)).not.toContain('hunter2hunter2')
    const full = thinkingFullText(reasoning)!
    expect(full.text).not.toContain('hunter2hunter2')
    // …including the part only the full read reaches.
    expect(full.text).not.toContain('zzREASONINGSECRETzz')
    expect(full.text).toContain('aws_secret_access_key=[REDACTED]')
  })

  it('pages an enormous section on an exact source cursor', () => {
    const huge = 'a'.repeat(FULL_TEXT_SECTION_MAX) + 'b'.repeat(1_000)
    const first = thinkingFullText(huge)!
    expect(first.text.length).toBe(FULL_TEXT_SECTION_MAX)
    expect(first.nextOffset).toBe(FULL_TEXT_SECTION_MAX)
    expect(first.totalChars).toBe(huge.length)
    const second = thinkingFullText(huge, first.nextOffset)!
    expect(second.nextOffset).toBeUndefined()
    // Offsets count SOURCE characters, so the pages join back into the source with
    // nothing dropped or repeated at the seam.
    expect(first.text + second.text).toBe(huge)
    // Past the end is an empty page, not an error or a wrapped read.
    expect(thinkingFullText(huge, huge.length + 10)!.text).toBe('')
  })

  it('advertises a fuller read only when there IS more than the excerpt', () => {
    // The predicate a row's `detailRef` is gated on. A false positive is a button
    // that answers with the text already on screen; a false negative loses the tail.
    expect(thinkingHasFullText('short reasoning')).toBe(false)
    expect(thinkingHasFullText('z'.repeat(2_000))).toBe(false)
    expect(thinkingHasFullText('z'.repeat(2_001))).toBe(true)

    expect(toolHasFullText({ command: 'echo hi' }, 'hi')).toBe(false)
    expect(toolHasFullText({ command: 'echo hi' }, 'x'.repeat(701))).toBe(true)
    // A value clipped INSIDE the render counts, even though the preview does not end
    // in an ellipsis (the keys after the fat one still render).
    const clippedInside = toolHasFullText({ command: 'x'.repeat(1_500), description: 'Build' }, 'ok')
    expect(clippedInside).toBe(true)
    // …and a mask that GROWS the text past the cap counts too: 690 raw characters
    // can still lose their tail once each 8-character value becomes "[REDACTED]".
    const nearCap = 'token=ab12cd34 '.repeat(46)
    expect(nearCap.length).toBeLessThan(700)
    expect(toolResultPreview(nearCap)!.length).toBeGreaterThan(700)
    expect(toolHasFullText({}, nearCap)).toBe(true)
  })
})
