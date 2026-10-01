/**
 * Where a semantic error in the rules file lives (C66). js-yaml gives no position for `then: 3`
 * or an unknown field, so `sort-rules-lines.ts` scans the raw text; when it cannot find the spot
 * it names the rule (`Rule 3 (r-7f3a2c): ...`) and never invents a line.
 */
import { describe, expect, it } from 'vitest'
import { lineOfError, rulesErrorOf, syntaxErrorOf, withLines } from '../../src/integrations/mail/sort-rules-lines.js'
import { parseRulesYaml } from '../../src/integrations/mail/sort-rules-file.js'
import { validateRulesDoc } from '../../src/integrations/mail/sort-rules-schema.js'

function firstError(text: string) {
  const result = validateRulesDoc(parseRulesYaml(text))
  if (result.ok) throw new Error('expected an invalid file')
  return rulesErrorOf(text, result.errors, 1000)
}

const HEAD = 'version: 1\ngroups:\n  - On-call & tickets\nrules:\n'

describe('semantic error lines', () => {
  it('then: 3 points at the then line of that rule', () => {
    const text = `${HEAD}  - id: r-111111\n    when: { from: "a@*" }\n    then: Important\n  - id: r-7f3a2c\n    when: { from: "b@*" }\n    then: 3\n`
    expect(firstError(text)).toEqual({ line: 10, rule: { index: 1, id: 'r-7f3a2c' }, message: 'then must name a group, Important or Not important.', since: 1000 })
  })
  it('an unknown rule field points at its own key', () => {
    const text = `${HEAD}  - when: { from: "a@*" }\n    then: Important\n    colour: red\n`
    expect(firstError(text)).toMatchObject({ line: 7, message: 'colour is not a rule field.' })
  })
  it('an unknown condition inside a block when points at that key', () => {
    const text = `${HEAD}  - when:\n      from: "a@*"\n      frm: "b@*"\n    then: Important\n`
    expect(firstError(text)).toMatchObject({ line: 7, message: 'when.frm is not a condition Walnut knows.' })
  })
  it('a typo in a group name points at the then line', () => {
    const text = `${HEAD}  - when: { from: "a@*" }\n    then: Importnat\n`
    expect(firstError(text)).toMatchObject({ line: 6, message: 'then: Importnat is not a group. Did you mean Important?' })
  })
  it('a duplicate id points at the second id', () => {
    const text = `${HEAD}  - id: r-7f3a2c\n    when: { from: "a@*" }\n    then: Important\n  - id: r-7f3a2c\n    when: { from: "b@*" }\n    then: Important\n`
    expect(firstError(text)).toMatchObject({ line: 8, message: 'Two rules use the id r-7f3a2c.' })
  })
  it('a slug collision in groups points at the second name', () => {
    const text = 'version: 1\ngroups:\n  - A&B\n  - A B\nrules: []\n'
    expect(firstError(text)).toMatchObject({ line: 4, message: '"A&B" and "A B" are too similar. Rename one of them.' })
  })
  it('comments and blank lines between items do not shift the count', () => {
    const text = `${HEAD}  # pager rules\n\n  - when: { from: "a@*" }\n    then: Important\n  # tickets\n  - when: { from: "b@*" }\n    then: 3\n`
    expect(firstError(text).line).toBe(11)
  })
})

describe('when the scan cannot find it', () => {
  it('a flow-style rule list names the rule instead of a line', () => {
    const text = 'version: 1\nrules: [{ id: r-111111, when: { from: "a@*" }, then: Important }, { id: r-222222, when: { from: "b@*" }, then: Important }, { id: r-7f3a2c, when: { from: "c@*" }, then: 3 }]\n'
    const error = firstError(text)
    expect(error.line).toBeUndefined()
    expect(error.message).toBe('Rule 3 (r-7f3a2c): then must name a group, Important or Not important.')
  })
  it('lineOfError answers undefined for an index past the list', () => {
    expect(lineOfError(`${HEAD}  - when: { from: "a@*" }\n    then: Important\n`, { index: 4, field: 'then', message: 'x' })).toBeUndefined()
  })
  it('withLines leaves errors without a line alone and adds lines where it can', () => {
    const text = `${HEAD}  - when: {}\n    then: Important\n`
    const result = validateRulesDoc(parseRulesYaml(text))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(withLines(text, result.errors)[0]).toMatchObject({ index: 0, field: 'when', line: 5 })
    expect(withLines(null, result.errors)[0]!.line).toBeUndefined()
  })
})

describe('syntax errors', () => {
  it('carry js-yaml mark line + 1', () => {
    let caught: unknown
    try { parseRulesYaml('version: 1\nrules:\n  - when: [\n') } catch (error) { caught = error }
    const error = syntaxErrorOf(caught, 5)
    expect(error.line).toBeGreaterThanOrEqual(3)
    expect(error.message).toMatch(/^The file is not valid YAML: /)
    expect(error.since).toBe(5)
  })
})
