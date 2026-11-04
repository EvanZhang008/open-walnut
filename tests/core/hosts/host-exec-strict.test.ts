/**
 * host_exec strict (src/core/hosts/host-exec-strict.ts): a pipe whose failing member is not its last
 * names that member. 2026-11-04 review: `false | cat` came back as failedStep.command `cat`.
 *
 * MACHINE SAFETY: pure functions; no process, file or network.
 */
import { describe, expect, it } from 'vitest'
import { failedStepOf, functionCall, lineOf, pipeMember, pipesOf, strictLine, withStepNamed, withoutInnerMarks, type FailedStep } from '../../../src/core/hosts/host-exec-strict.js'
import { strictMark } from '../../../src/providers/host-exec-line.js'

const step = (o: Partial<FailedStep>): FailedStep => ({ exitCode: 1, command: 'cat', ...o })
const J = 'hx-strict-test-1'
// The run's seal (host-exec-strict.ts sealFor): unknown here, so any of the right form counts.
const M = strictMark(J, 'a1b2c3d4e5f6')
// Walnut's line as the answer shows it, without the seal.
const V = strictMark(J)

describe('a pipe\'s failing member', () => {
  it('is read from the line when the line splits into as many members as the pipe had', () => {
    expect(pipeMember(step({ pipeStatus: [1, 0], text: 'false | cat' })).command).toBe('false')
    expect(pipeMember(step({ pipeStatus: [0, 1, 0], text: 'true | grep -q x /dev/null | cat' })).command).toBe('grep -q x /dev/null')
  })

  it('is read from the one pipe on a longer line that has the pipe\'s size and ends in the command bash named (2026-11-05 review)', () => {
    expect(pipeMember(step({ pipeStatus: [0, 1, 0], text: 'echo one; true | false | cat; echo SHOULD_NOT_PRINT' })).command).toBe('false')
    expect(pipeMember(step({ pipeStatus: [2, 0], text: 'echo building; ls /nope-rv9 | cat; sleep 5' })).command).toBe('ls /nope-rv9')
    // a || b | cat is a || (b | cat): the pipe is b | cat.
    expect(pipeMember(step({ pipeStatus: [1, 0], text: 'a || b | cat' })).command).toBe('b')
    // Quotes, $(...) and redirections are no separators.
    expect(pipeMember(step({ pipeStatus: [1, 0], text: 'echo "a; b | c" && grep -q "x|y" f 2>&1 | cat' })).command).toBe('grep -q "x|y" f 2>&1')
    expect(pipeMember(step({ pipeStatus: [1, 0], text: 'v=$(echo a | tr a b); false | cat' })).command).toBe('false')
    // Several pipes of that size ending in it: which one failed is not known here.
    expect(pipeMember(step({ pipeStatus: [1, 0], text: 'a | cat; b | cat' })).command).toBe('cat')
  })

  it('Walnut\'s own line about the step names the command failedStep names; only the last such line', () => {
    const out = `a\n\n${M} 1 [0 1 0]: cat\n`
    expect(withStepNamed(out, step({ command: 'false', pipeStatus: [0, 1, 0] }), J)).toBe(`a\n\n${V} 1 [0 1 0]: false\n`)
    expect(withStepNamed(out, step({ command: 'cat', pipeStatus: [0, 1, 0] }), J)).toBe(`a\n\n${V} 1 [0 1 0]: cat\n`)
    const two = `${M} 1 []: inner\nx\n${M} 2 [2 0]: cat`
    expect(withStepNamed(two, step({ exitCode: 2, command: 'ls /nope' }), J)).toBe(`${M} 1 []: inner\nx\n${V} 2 [2]: ls /nope`)
    expect(withStepNamed('no marker\n', step({ command: 'x' }), J)).toBe('no marker\n')
  })

  it('only this job\'s marker counts, and only when the run ended with its code (2026-11-05 review 12)', () => {
    // A run without strict printing the old text came back with a failed step it never had.
    expect(failedStepOf('walnut strict: exit 9 [9]: NOT_REAL\nREADY\n', J, 0)).toBeNull()
    expect(failedStepOf('walnut strict hx-other-job: exit 1 [1]: false\n', J, 1)).toBeNull()
    expect(failedStepOf(`${M} 9 [9]: x\n`, J, 0)).toBeNull()
    expect(failedStepOf(`${M} 0 [0]: READY\n`, J, 0)).toBeNull()
    expect(failedStepOf(`${M} 1 [1]: false\n`, J, null)).toBeNull()
    expect(failedStepOf(`${M} 1 [1]: false\n`, J, 1)).toEqual({ exitCode: 1, command: 'false' })
    expect(() => strictLine('true', 'hx-a\'b')).toThrow()
    // Walnut's prefix sits on the line's first line, so bash counts the caller's lines; nothing follows the caller's.
    expect(strictLine('echo a\ncd /nope', 'hx-strict-line-1').split('\n').slice(1)).toEqual(['cd /nope'])
  })

  it('a line the job prints in Walnut\'s form, its own id included, is output: only the run\'s seal counts (2026-11-05 review claude13)', () => {
    const id = 'hx-strict-seal-1'
    const line = strictLine('true', id)
    const seal = /walnut strict hx-strict-seal-1 ([0-9a-f]{12}): exit/.exec(line)![1]!
    const real = `\n${strictMark(id, seal)} 1 [1] line 1: false\t(bash 5, bg 0)\n`
    // `echo 'walnut strict <id>: exit 7 [7] line 1: fake'; exit 7`, and the same from an EXIT trap after the real one.
    expect(failedStepOf(`walnut strict ${id}: exit 7 [7] line 1: fake\n`, id, 7)).toBeNull()
    expect(failedStepOf(`${strictMark(id, '000000000000')} 7 [7] line 1: fake\n`, id, 7)).toBeNull()
    expect(failedStepOf(`${real}walnut strict ${id}: exit 1 [1] line 1: fake-from-trap\n`, id, 1)).toEqual({ exitCode: 1, command: 'false', bashLine: 1 })
    // The answer shows Walnut's line without the seal.
    expect(withStepNamed(real, { exitCode: 1, command: 'false', line: 1 }, id)).toBe(`\n${strictMark(id)} 1 [1] line 1: false\n`)
  })

  it('a step whose $PIPESTATUS is an earlier pipe\'s is shown with its own code (2026-11-05 review claude13: `(( 0 ))` read [0])', () => {
    expect(failedStepOf(`${M} 1 [0] line 1: (( 0 ))\t(bash 5, bg 0)\n`, J, 1)).toEqual({ exitCode: 1, command: '(( 0 ))', bashLine: 1 })
    expect(failedStepOf(`${M} 1 [0 0] line 2: [[ -f /nope ]]\t(bash 5, bg 0)\n`, J, 1)).toEqual({ exitCode: 1, command: '[[ -f /nope ]]', bashLine: 2 })
    expect(withStepNamed(`${M} 1 [0] line 1: (( 0 ))\n`, { exitCode: 1, command: '(( 0 ))', line: 1 }, J)).toBe(`${V} 1 [1] line 1: (( 0 ))\n`)
  })

  it('a function\'s own return names the call of that function on bash\'s line, when the line calls one it defines (2026-11-05 review 12)', () => {
    const cmd = 'echo a\nf() { return 3; }\necho b\nf\necho never'
    expect(functionCall({ exitCode: 3, command: 'return 3', bashLine: 4 }, cmd)).toEqual({ exitCode: 3, command: 'f', bashLine: 4, line: 4, text: 'f', returned: 'return 3' })
    // The line is the definition (bash 4 counts otherwise), or calls none: left as bash named it.
    expect(functionCall({ exitCode: 3, command: 'return 3', bashLine: 2 }, cmd).command).toBe('return 3')
    expect(functionCall({ exitCode: 3, command: 'return 3', bashLine: 3 }, cmd).command).toBe('return 3')
    expect(functionCall({ exitCode: 3, command: 'return 3' }, cmd).command).toBe('return 3')
    expect(functionCall({ exitCode: 1, command: 'false', bashLine: 4 }, cmd).command).toBe('false')
    expect(functionCall({ exitCode: 2, command: 'return 2', bashLine: 2 }, 'function check { return 2; }\nx=1; check && true; check').command).toBe('check')
  })

  it('pipesOf cuts a line into its pipes and their members', () => {
    expect(pipesOf('a | b && c; d |& e & f')).toEqual([['a', 'b'], ['c'], ['d', 'e'], ['f']])
    expect(pipesOf("echo 'x | y' | wc -l")).toEqual([["echo 'x | y'", 'wc -l']])
    expect(pipesOf('cmd >&2 | tee log')).toEqual([['cmd >&2', 'tee log']])
  })

  it('stays as bash named it when the last member failed, the line does not split to the count, or there is no line', () => {
    expect(pipeMember(step({ command: 'grep x', pipeStatus: [0, 1], text: 'cat f | grep x' })).command).toBe('grep x')
    // Two pipes of that size, neither ending in the command bash named: as it is.
    expect(pipeMember(step({ pipeStatus: [1, 0], text: 'a | x; b | y' })).command).toBe('cat')
    expect(pipeMember(step({ pipeStatus: [1, 0] })).command).toBe('cat')
    expect(pipeMember(step({ command: 'false' })).command).toBe('false')
  })
})

describe('a subshell\'s own line (2026-11-05 review: `echo a; (false)` named `echo a`, in two lines)', () => {
  const inner = (rc: number, cmd: string, bash = 5, ps = String(rc)) => `\n${M} ${rc} [${ps}]: ${cmd}\t(in a subshell, bash ${bash})\n`
  const outer = (rc: number, ps: string, cmd: string) => `\n${M} ${rc} [${ps}]: ${cmd}\n`

  it('lends its command to the shell\'s own line after it, with the same code; the pipe codes stay the shell\'s', () => {
    expect(failedStepOf(`a\n${inner(1, 'false')}${outer(1, '1', '( false )')}`, J, 1)).toEqual({ exitCode: 1, command: 'false' })
    expect(failedStepOf(`${inner(1, 'false')}${outer(1, '1 0', 'cat')}`, J, 1)).toEqual({ exitCode: 1, command: 'false', pipeStatus: [1, 0], inner: true })
    // Another code: the shell failed on something else.
    expect(failedStepOf(`${inner(2, 'ls /nope')}${outer(1, '1', 'false')}`, J, 1)).toEqual({ exitCode: 1, command: 'false' })
  })

  it('alone (a background `( … ) &` that failed) is no failed step; a line from an older server reads as before', () => {
    expect(failedStepOf(`x\n${inner(1, 'false')}done\n`, J, 0)).toBeNull()
    expect(failedStepOf(outer(3, '3', 'return 3'), J, 3)).toEqual({ exitCode: 3, command: 'return 3' })
    // A line from a server older than the job id in it reads as no step.
    expect(failedStepOf('\nwalnut strict: exit 3 [3]: return 3\n', J, 3)).toBeNull()
  })

  it('is taken out of the answer with the empty line before it, and the shell\'s line names the step', () => {
    const out = `a\n${inner(1, 'false')}${outer(1, '1', '( false )')}`
    const step = failedStepOf(out, J, 1)!
    expect(withStepNamed(withoutInnerMarks(out, J), step, J)).toBe(`a\n${V} 1 [1]: false\n`)
    expect(withoutInnerMarks('plain\noutput\n', J)).toBe('plain\noutput\n')
  })

  it('Walnut\'s line gives the step\'s own code and pipe codes, a subshell\'s pipe included (2026-11-05 review sol13: `[2]` beside pipeStatus [2,0])', () => {
    const out = `ls: /nope: No such file\n${M} 2 [2] line 1: ( ls /nope | cat )\n`
    expect(withStepNamed(out, { exitCode: 2, command: 'ls /nope', pipeStatus: [2, 0], line: 1 }, J)).toBe(`ls: /nope: No such file\n${V} 2 [2 0] line 1: ls /nope\n`)
    expect(withStepNamed(`${M} 1 [1]: echo a\n`, { exitCode: 2, command: 'cat', pipeStatus: [2, 0] }, J)).toBe(`${V} 2 [2 0]: cat\n`)
  })
})

describe('a subshell under each bash (2026-11-05 code review 12; measured on bash 5.2, 4.2 and macOS 3.2)', () => {
  const inner = (rc: number, cmd: string, bash: number, ps = String(rc)) => `\n${M} ${rc} [${ps}]: ${cmd}\t(in a subshell, bash ${bash})\n`
  const outer = (rc: number, ps: string, cmd: string) => `\n${M} ${rc} [${ps}]: ${cmd}\n`

  it('marks only a failure that ends its shell, and keeps the caller\'s last command from being exec\'d in the shell\'s place', () => {
    const line = strictLine('echo a\ngrep -q x /dev/null', 'hx-strict-line-2')
    expect(line).toContain('case $- in *e*) printf')
    // An EXIT trap, not a command after the caller's (code review 13: `echo a &&` then ran).
    expect(line).toContain("trap : EXIT; trap 'walnut_rc=")
    expect(line.endsWith('; echo a\ngrep -q x /dev/null')).toBe(true)
  })

  it('bash 5 names the subshell as written: its line lends the command; a background one earlier does not', () => {
    expect(failedStepOf(`a\n${inner(1, 'false', 5)}${outer(1, '1', '( false )')}`, J, 1)?.command).toBe('false')
    // `( sleep 0.1; false ) &` then a failing test: the shell's own step failed.
    expect(failedStepOf(`${inner(1, 'false', 5)}${outer(1, '1', 'test -f /no/such')}`, J, 1)?.command).toBe('test -f /no/such')
    // A pipe inside the subshell: its failing member, read from the subshell's text.
    expect(failedStepOf(`${inner(2, 'cat', 5, '2 0')}${outer(2, '2', '( ls /nope | cat )')}`, J, 2)).toEqual({ exitCode: 2, command: 'ls /nope', pipeStatus: [2, 0], inner: true })
  })

  it('bash 4 names a command it ran before: the subshell\'s line right before lends its command, whatever its code', () => {
    expect(failedStepOf(`a\n${inner(1, 'false', 4)}${outer(1, '1', 'echo a')}`, J, 1)?.command).toBe('false')
    expect(failedStepOf(`${inner(2, 'cat', 4, '2 0')}${outer(1, '1', "trap 'x' ERR")}`, J, 1)).toEqual({ exitCode: 2, command: 'cat', pipeStatus: [2, 0] })
    // Output between them: not the subshell's failure passed out.
    expect(failedStepOf(`${inner(1, 'false', 4)}later\n${outer(1, '1', 'test -f /no/such')}`, J, 1)?.command).toBe('test -f /no/such')
  })

  it('bash 3.2 ends after the subshell without a line of its own: the subshell\'s line last of all is the step when the run exited with its code', () => {
    expect(failedStepOf(`a\n${inner(1, 'false', 3)}`, J, 1)).toEqual({ exitCode: 1, command: 'false' })
    expect(failedStepOf(`${inner(1, 'cat', 3, '1 0')}`, J, 1)).toEqual({ exitCode: 1, command: 'cat', pipeStatus: [1, 0] })
    expect(failedStepOf(`a\n${inner(1, 'false', 3)}done\n`, J, 0)).toBeNull()
    // A background subshell failed, then the shell's own step: that step.
    expect(failedStepOf(`${inner(1, 'false', 3)}${outer(1, '1', 'test -f /no/such')}`, J, 1)?.command).toBe('test -f /no/such')
  })

  it('a pipe inside a subshell that is a member of the line is found there; bash\'s spacing is no difference', () => {
    expect(pipeMember({ exitCode: 1, command: 'cat', pipeStatus: [1, 0], text: '(ls /nope | cat)' }).command).toBe('ls /nope')
    expect(pipeMember({ exitCode: 141, command: 'head -1 > /dev/null', pipeStatus: [141, 0], text: 'yes | head -1 >/dev/null' }).command).toBe('yes')
    expect(lineOf({ exitCode: 141, command: 'head -1 > /dev/null' }, 'yes | head -1 >/dev/null\necho never')).toBe(1)
    // A command named inside a subshell is not renamed by a pipe of the line.
    expect(pipeMember({ exitCode: 1, command: 'false', pipeStatus: [0, 1, 0], text: 'true | { false; echo x; } | cat', inner: true }).command).toBe('false')
  })
})

describe('lines as each bash printed them (2026-11-05 code review 13; real runs on bash 5.2, 4.2 and macOS 3.2)', () => {
  const m = (rc: number, ps: string, line: number, cmd: string, tag: string) => `\n${M} ${rc} [${ps}] line ${line}: ${cmd}\t(${tag})\n`

  it('bash 5: a pipe ending in a loop or `{ … }` names the command inside that failed, not one the shell ran before', () => {
    const loop = `${m(1, '1', 1, 'grep -q "zz$l" /etc/hostname', 'in a subshell, bash 5, pid 50')}${m(1, '0 1', 1, "printf 'a\\nb\\n'", 'bash 5, bg 0')}`
    expect(failedStepOf(loop, J, 1)).toEqual({ exitCode: 1, command: 'grep -q "zz$l" /etc/hostname', bashLine: 1, pipeStatus: [0, 1], inner: true })
    const group = `${m(1, '1', 1, 'false', 'in a subshell, bash 5, pid 55')}${m(1, '0 1', 1, 'echo hi', 'bash 5, bg 0')}`
    expect(failedStepOf(group, J, 1)?.command).toBe('false')
  })

  it('a background subshell lends nothing, its pid being the shell\'s $!, nor across output, nor to `(( … ))`', () => {
    const bgPipe = `${m(1, '1', 1, 'grep -q nomatch-zz /etc/hostname', 'in a subshell, bash 5, pid 21')}${m(1, '1 0', 4, 'cat', 'bash 5, bg 21')}`
    expect(failedStepOf(bgPipe, J, 1)).toEqual({ exitCode: 1, command: 'cat', bashLine: 4, pipeStatus: [1, 0] })
    // The same with another pid: a member of this pipe; with output between: not.
    expect(failedStepOf(bgPipe.replace('bg 21', 'bg 0'), J, 1)?.command).toBe('grep -q nomatch-zz /etc/hostname')
    expect(failedStepOf(bgPipe.replace('bg 21', 'bg 0').replace(`\n\n${M} 1 [1 0]`, `\nmid\n\n${M} 1 [1 0]`), J, 1)?.command).toBe('cat')
    const arith = `${m(1, '1', 1, 'grep -q x f', 'in a subshell, bash 5, pid 0')}${m(1, '0', 4, '(( 1 == 2 ))', 'bash 5, bg 0')}`
    expect(failedStepOf(arith, J, 1)?.command).toBe('(( 1 == 2 ))')
    const bash4 = `${m(1, '1', 0, 'false', 'in a subshell, bash 4, pid 5769')}${m(1, '1', 2, 'grep -q zz /etc/hostname', 'bash 4, bg 5769')}`
    expect(failedStepOf(bash4, J, 1)?.command).toBe('grep -q zz /etc/hostname')
  })

  it('bash 4: nested subshells give the innermost command; Walnut\'s own trap is never the step', () => {
    const trap = "trap 'walnut_rc=$? walnut_ps=\"${PIPESTATUS[*]}\"; …' ERR"
    const nested = `${m(1, '1', 0, 'false', 'in a subshell, bash 4, pid 5173')}${m(1, '1', 0, trap, 'in a subshell, bash 4, pid 5172')}${m(1, '1', 0, trap, 'bash 4, bg 0')}`
    expect(failedStepOf(nested, J, 1)?.command).toBe('false')
    expect(failedStepOf(m(1, '1', 0, trap, 'bash 4, bg 0'), J, 1)).toBeNull()
    expect(failedStepOf(m(1, '1', 0, 'trap : EXIT', 'bash 4, bg 0'), J, 1)).toBeNull()
  })

  it('bash\'s line number is used only from bash 5, so a function\'s `return` on bash 4 names no wrong call', () => {
    const cmd = 'prepare() { :; }\nprepare\nverify() { return 4; }\nverify'
    const four = failedStepOf(m(4, '4', 2, 'return 4', 'bash 4, bg 0'), J, 4)!
    expect(four).toEqual({ exitCode: 4, command: 'return 4' })
    expect(functionCall(four, cmd).command).toBe('return 4')
    const five = failedStepOf(m(4, '4', 4, 'return 4', 'bash 5, bg 0'), J, 4)!
    expect(functionCall(five, cmd)).toMatchObject({ command: 'verify', line: 4, returned: 'return 4' })
  })

  it('a pipe ending in `( … )` that exits by itself is named by the line when bash named an earlier command', () => {
    const step = failedStepOf(m(3, '0 3', 0, 'echo x', 'bash 4, bg 0'), J, 3)!
    expect(pipeMember({ ...step, line: 1, text: 'echo x | ( read v; exit 3 )' }).command).toBe('( read v; exit 3 )')
  })

  it('bash 3.2: a subshell\'s line last of all is the step only with nothing printed after it', () => {
    expect(failedStepOf(m(1, '1', 0, 'false', 'in a subshell, bash 3, pid 0'), J, 1)).toEqual({ exitCode: 1, command: 'false' })
    // `( …; grep -q x f ) &` then `echo mid` then a silent `(( 1 == 2 ))`; `set +e` then a subshell, `echo after`, a failing test.
    expect(failedStepOf(`${m(1, '1', 0, 'grep -q nomatch-zz /etc/hosts', 'in a subshell, bash 3, pid 0')}mid\n`, J, 1)).toBeNull()
    expect(failedStepOf(`${m(1, '1', 1, 'false', 'in a subshell, bash 3, pid 0')}after\n`, J, 1)).toBeNull()
  })

  it('the answer keeps no bash tag on the shell\'s line, and drops the subshell\'s line', () => {
    const out = `a\n${m(1, '1', 1, 'false', 'in a subshell, bash 5, pid 7')}${m(1, '1', 1, '( false )', 'bash 5, bg 0')}`
    expect(withoutInnerMarks(out, J)).toBe(`a\n${M} 1 [1] line 1: ( false )\n`)
  })
})
