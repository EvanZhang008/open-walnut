/**
 * A Bash cut counts against a Walnut op only when the saved output can be that op's answer
 * (src/core/usage-watch/normalize.ts walnutToolCall).
 *
 * 2026-11-24: host_copy_result's cut alarm rang on `o=$(walnut tools call host_copy_result ..); ..;
 * tar -xzf .. && ls ..; grep -rn .. | head`: the op answered 521 bytes into a variable, and the 19 KB
 * Claude Code saved to a file were file names and log lines of the other commands.
 */
import { describe, expect, it } from 'vitest'
import { walnutToolCall } from '../../../src/core/usage-watch/normalize.js'
import { shellCommands } from '../../../src/core/usage-watch/shell-words.js'

const bash = (command: string) => walnutToolCall('Bash', { command })
const call = (op: string) => `walnut tools call ${op} '{"id":"x"}'`

/** One line per way a shell line ends or opens a command: each says whether the call's answer is what the agent reads. */
const BY_SEPARATOR: Record<string, { answered: string[]; notAnswered: string[] }> = {
  ';': { answered: [`sleep 5; ${call('task_get')}`], notAnswered: [`${call('task_get')}; cat /tmp/big.log`] },
  '&': { answered: [`cd /x && ${call('task_get')}`, `sleep 1 & ${call('task_get')}`], notAnswered: [`${call('task_get')} && ls -la /tmp`, `${call('task_get')} & ls /tmp`] },
  '|': { answered: [`${call('task_get')} || echo failed`], notAnswered: [`${call('task_get')} | head -50`, `${call('task_get')} || cat /tmp/x`] },
  '\n': { answered: [`export A=1\n${call('task_get')}`], notAnswered: [`${call('task_get')}\ngrep -rn x /tmp/logs`] },
  '(': { answered: [`( ${call('task_get')} )`], notAnswered: [`o=$(${call('task_get')}); echo "$o" | tail -3`, `diff <(${call('task_get')}) /tmp/a`] },
  ')': { answered: [`(cd /x) && ${call('task_get')}`], notAnswered: [`o=$(${call('task_get')})`] },
  '`': { answered: [`cd \`pwd\` && ${call('task_get')}`], notAnswered: [`o=\`${call('task_get')}\`; echo "$o"`] },
}

describe('a Bash cut counts for an op only when the saved output can be its answer alone', () => {
  it('the line that rang host_copy_result\'s alarm is not its answer', () => {
    const line = 'R=/home/u/.local/state/open-walnut/tasks/t1/ios-fleet/run1; for i in 1 2 3 4 5 6; do o=$(walnut tools call host_copy_result \'{"copy_id":"hc-1"}\'); echo "$o" | grep -q "Not done yet" || break; done; echo "$o" | tail -3; tar -xzf $R/out.tgz -C $R/out && ls $R/out; grep -rn "results:" $R/out/*.log $R/run.log 2>/dev/null | head'
    expect(bash(line)).toEqual({ op: 'host_copy_result', answered: false })
  })

  it('a call inside a loop or an if is still read as a call', () => {
    expect(bash(`for i in 1 2 3; do ${call('task_get')}; done`)).toEqual({ op: 'task_get', answered: true })
    expect(bash(`if [ -d /x ]; then ${call('task_get')}; fi`)).toEqual({ op: 'task_get', answered: true })
    expect(bash(`while true; do ${call('task_get')} && break; sleep 2; done`)).toEqual({ op: 'task_get', answered: true })
  })

  it('an echo of fixed words adds nothing; an echo of a variable may print anything', () => {
    expect(bash(`echo "--- task"; ${call('task_get')}`)).toEqual({ op: 'task_get', answered: true })
    expect(bash(`echo "$BIG"; ${call('task_get')}`)).toEqual({ op: 'task_get', answered: false })
    expect(bash(`ls /x > /tmp/list; ${call('task_get')}`)).toEqual({ op: 'task_get', answered: true })
  })

  it('a second walnut call in the line makes the saved output both answers', () => {
    expect(bash(`${call('task_get')}; ${call('task_history')}`)).toEqual({ op: 'task_get', answered: false })
  })

  it('the call whose output reaches the screen names the line', () => {
    expect(bash(`id=$(${call('host_copy')}); ${call('task_get')}`)).toEqual({ op: 'task_get', answered: true })
    expect(bash(`${call('task_get')} | jq .id`)).toEqual({ op: 'task_get', answered: false })
  })

  it('a line or the exit status beside the call is no cut of its own', () => {
    for (const line of [
      `${call('task_get')}; echo "exit=$?"`,
      `${call('task_get')} || echo "failed: $?"`,
      `pwd; date; ${call('task_get')}`,
      `if grep -q x /tmp/f; then ${call('task_get')}; fi`,
    ]) expect(bash(line), line).toEqual({ op: 'task_get', answered: true })
  })

  it('every way the parser ends or opens a command has its cases', () => {
    for (const [sep, cases] of Object.entries(BY_SEPARATOR)) {
      for (const line of cases.answered) expect(bash(line)?.answered, `${JSON.stringify(sep)}: ${line}`).toBe(true)
      for (const line of cases.notAnswered) expect(bash(line)?.answered, `${JSON.stringify(sep)}: ${line}`).toBe(false)
    }
    // Ratchet: every character the parser ends a command at (asked of the parser itself, however
    // its code is written) needs a row above saying how a cut reads around it.
    const candidates = ['\n', '\t', ...Array.from({ length: 94 }, (_, k) => String.fromCharCode(33 + k)).filter((ch) => !/[A-Za-z0-9]/.test(ch))]
    const splitting = candidates.filter((ch) => shellCommands(`a${ch}b`).length >= 2 || shellCommands(`a ${ch} b`).length >= 2)
    expect(splitting.sort()).toEqual(Object.keys(BY_SEPARATOR).sort())
  })

  it('the parser marks what runs in a substitution', () => {
    expect(shellCommands('o=$(walnut tools call a); b').map((c) => [c.words[0], c.sub])).toEqual([['o=$', false], ['walnut', true], ['b', false]])
    expect(shellCommands('x `y` z').map((c) => [c.words[0], c.sub])).toEqual([['x', false], ['y', true], ['z', false]])
    expect(shellCommands('(a) && b').map((c) => [c.words[0], c.sub])).toEqual([['a', false], ['b', false]])
  })
})
